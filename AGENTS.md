# AGENTS.md — 开发调试速查

TokenLedger 最低支持 Paseo v0.11.0，不设版本上限（id `token-ledger`，SDK 开发依赖固定 0.11.1；已验证宿主 0.11.1）。0.9.1–0.10.x 用户留在 v0.6.3。允许加载不代表所有未来版本均已实测；兼容策略与验证记录见 `docs/compatibility.md`。**若存在 `AGENTS.local.md`（gitignore，本机专用），先读它——本机路径、工具链怪癖、测试 provider、账号事项都在那里，其内容优先于本文件。**

## 开发循环

```bash
node node_modules/typescript/lib/tsc.js --noEmit   # typecheck（等价 tsc --noEmit）
node --test shared/*.test.ts server/*.test.ts      # 单测（Node 24 原生跑 TS）
paseo plugin reload token-ledger                   # 改完源码必须 reload 才生效
paseo plugin logs token-ledger                     # 服务端 console.log/error 都在这
paseo plugin ls                                    # 状态须为 running 且无 ERROR
```

- **不要重启 daemon**（`paseo daemon restart`）——会杀掉所有正在跑的 agent，包括正在执行开发任务的你自己。reload 插件即可加载新代码。
- 客户端 UI 改动 reload 后，已打开的桌面端可能持有旧 bundle，需要重启桌面端窗口（安全，不影响 daemon）。

## 实测一轮 turn

```bash
paseo agent run --provider <见 AGENTS.local.md> --title "test" "Reply with exactly: pong"
tail -1 <daemon home>/plugins/token-ledger/ledger.jsonl   # 看落库记录
paseo agent archive <id>                                  # 测完归档，别留垃圾
```

## 架构要点（从 daemon 源码验证过，别只信官方文档）

- 自 0.8 起必须分离入口：`index.client.tsx` / `index.server.ts`，代码分别放 `client/`、`server/`、`shared/`。文件后缀不再划分边界；禁止跨端 import。当前 manifest 声明 `requirements.paseo: ">=0.11.0"`；不要仅因宿主次版本升级而新增上限。只有采用必要的新 API 或确认破坏性变更时才调整范围，实测版本单独记录。
- 服务端 contribute 拿到 `handle/on/before`，`paseo` 在 RPC 和生命周期回调中提供。`before(agent.session_open)` 启动订阅，`on(agent.turn_started)` 覆盖 reload 后已有会话；客户端 ensure 尽早连接已有会话。**新建 agent 在 session_open 时尚未进入目录，不能在此 refresh 新 agent。**
- **wire 层 `agent_stream` 没有 `usage_updated`**：轮中 usage 走 `agent_update` upsert 快照（`lastUsage`/`activeTurn`），且必须先 `paseo.agents.list({ subscribe: {} })` 才会推送。turn 生命周期（started/completed/failed/canceled + turnId + 轮末 usage）走 `agents.ref(id).timeline.subscribe`。
- usage 语义（2026-09-04 实测）：Claude 轮末 usage 是**逐轮**汇总、`totalCostUsd` 是**会话累计**（所以记录里存 delta + raw 两份）；Codex 每次模型请求报一次 `last` 值，多请求轮靠去重求和。快照会把上一轮旧 usage 回放进新一轮——tracker 用 agent 级 `lastObservation` 基线挡掉。
- **Paseo 丢弃 `cache_creation_input_tokens`**（2026-09-05 从 app.asar 的 `providers/claude/agent.js` `buildResultUsage` ~1424 行验证）：`cachedInputTokens` 只映射 `cache_read_input_tokens`，cache write 只用于上下文窗口内部估算、不进 `AgentUsage`。后果：用户输入和工具结果（几乎全是 cache write，计费 1.25× input 价）在 IN 和 CACHE 两列都不可见，IN 通常只有零头（个位数~几十）；`costUsd` 仍准确（上游总额含 write）。pricing.ts 的分项估算按牌价直算，总额与估算的差额单列为 `otherUsd`（COST 列下方显示 `+$x.xx`）——不再 rescale 摊进分项。token 数本身的缺口需上游 Paseo 加字段，插件侧无法拿到。
- **input 语义因 provider 而异**（2026-09-05 从落库记录实测）：codex/OpenAI 系的 `inputTokens` **含** cached（如 input 213818 / cached 213252，真实新增仅 566）；Claude 的 input **不含** cache read。`semantics.ts` 维护按 provider（回退 model）匹配的语义表，归一化到"input = 未命中缓存的新输入"（Anthropic 式，信息不丢失）。磁盘 ledger.jsonl 永远存上游原始值，归一化只在读取/服务层做（store 的 summary、tracker 的 handleSync 和 inFlightFor），历史记录自动被正确重解读。新接 provider：跑一轮真实 turn → 看落库记录判断 input 是否含 cached → 往 SEMANTICS_TABLE 加一行 + 测试。未知 provider 原样透传，不猜。
- **turnId 不是全局唯一的**（2026-09-07 从 ledger.jsonl 实测）：Paseo 的 turnId 形如 `foreground-turn-N`，agent/daemon 会话重启后从 1 重新计数。任何以 `agentId:turnId` 当唯一键的地方都会跨会话冲突——曾导致面板 React key 重复、渲染出幽灵重复行。现在记录 id 拼入 `endedAt`（aggregate.ts），面板行 key 用 `seq`（兼容旧格式的历史记录）。新代码需要唯一键时同样别只用 turnId。
- **终止事件后快照可能回放 activeTurn**（同日实测，曾造成 3ms 内同一 turn 落库两条）：turn_completed 之后紧跟的 agent_update 快照仍带着刚结束的 turn，noteUsage 若据此重开 open turn，下个终止事件就会重复落库。tracker 用 `lastClosedTurnId` 挡掉（新轮保留旧 ID 以屏蔽迟到事件；provider session 确认改变时重置）。改 turn 生命周期逻辑时注意 timeline 事件流和快照流是两条异步通道，顺序无保证。

## Paseo 0.8 适配注意事项

- 徽标改为 `addComposerPill({ button: { title, icon, label, behavior } })`，返回 `{ update, remove }`。Hook 和客户端类型从 `/client` 导入；`defineRpc` 和 `PluginTheme` 从根包导入。
- timeline 取消函数带 `ready` Promise，需处理拒绝。新增 `replacement` 事件没有 timestamp，仅表示历史失效，不是 live turn。
- `server/turns.ts` 处理双通道乱序：同 ID start 幂等，终止事件核对当前 ID，旧快照不重开已关闭 turn，失败/取消不把旧 usage 当作精确终值。
- Claude 终值优先于中间快照；已知 provider sessionId 变化才清零费用基线，resume 同一 session 不清零。历史 v1 账本可缺少 sessionId。
- 会话和 workspace 列表必须翻页；JSONL 追加与裁剪串行化，读错误不能一律当首次启动。
- 0.8.0 的 Claude cache write 缺字段、Codex input 包含 cached 的语义仍然存在。

## 0.8 优化后的约束

- `server/journal.ts` 保存 open turn、session/cost 基线及 pending records；先写 journal 再 append JSONL，open.key 是稳定 UUID。结束 hook 无 usage，短暂等待 timeline 终值后按已观测数据结算；清理时完成已知的结束 hook。
- `server/read-model.ts` 按 store/pricing revision 缓存归一化行与汇总；`client/data.ts` 共享 panel/pill 查询并合并未变化的 records。RPC 的空 records 配合相同 recordsRevision 表示未变化，不表示历史清空。
- `server/catalog.ts` 复用完整 agent 目录并订阅分页 workspace 目录；总览不再每次查询只取前 200 个 agent。
- `providerSemantics` 只按已验证 harness 匹配：Claude whole-turn + session cost；Codex request observations；未知取最新观察且标 partial，原始费用保留但不推断累计差值。model fallback 仅用于 input/cache 口径。
- 新 Codex 记录的 requests 保留原始逐请求 token，用于逐请求价格档位；旧记录没有请求明细，只能近似。pricing.json 最后档必须无上限，档位递增；运行时重新读取无效文件会保留上一份有效价格。
- Timeline 使用 append + addTimelineRenderer：先落盘、每轮一次、稳定 ID、最多重试一次。不要高频更新或全历史回填；append 会改变 agent.updatedAt，且 plugin rows 不保证 daemon 重启后保留。JSONL 是权威账本。

## 0.9.1 适配约束

- `agents.list` / `workspaces.list` 使用 `subscribe: {}`，禁止传自定义 `subscriptionId`；类型检查不一定报错，但真实 SDK 会拒绝。保存返回的 `OwnedSubscription`，cleanup 必须 await `release()`。不要 dispose 宿主借给插件的整个 `PaseoApi`。
- `shared/catalog-subscription.ts` 接管完整分页快照和恢复快照，并让分页期间的实时 upsert/remove 覆盖旧值。SDK 的 `agents.subscribe` 只转发实时更新，不转发重连快照。新客户端代码不能只靠那个回调重建目录。
- `server/subscriptions.ts` 处理 Timeline 的 `subscription_restored` / `error`；`ready` 只代表首次建立，不能发现已建立后的失败。迟到回调不能清理替换后的句柄；关闭和归档必须停止重试。
- 断线缺口落 `usageGap`，缺失终态记 `unknown`。跨缺口的 session 累计费用只存 raw，不强行归入当前轮；缺口和基线状态随 journal 恢复。不要给恢复记录补发 Timeline。
- `shared/preferences.ts` 定义宿主原生设置，`server/preferences.ts` 读取并订阅；客户端用 `useSettings`。设置读回与通知有竞态，迟到 read 不能覆盖更新值。价格配置 revision 必须使 read-model 失效。
- 0.9.1 仍未公开 cache-write 和 provider 内部子代理 usage；不要把本地结构支持写成上游已经提供数据。标准模型价格需精确匹配，未知新版本或 Fast/Batch 后缀不能套用旧模型回退价。

## 0.11 适配约束

- **发布代码禁止 import `@getpaseo/client` / `@getpaseo/protocol`**（含 type-only）。宿主编译插件时会解析 type-only import，但只提供 SDK specifier、zod、react、react-native、@tanstack/react-query、@types/node。git 安装不跑 `npm install`（只跑 manifest `build`），npm 安装不装 devDependencies，所以其他类型依赖会让安装失败（0.11.1 实测 `Could not resolve type dependency`）。客户端类型从 `client/paseo-types.ts` 取，服务端从 `server/paseo-types.ts` 取（都由宿主 `PaseoApi` 推导）。`shared/` 不能 import `/client` 或 `/server` SDK，用结构类型和泛型。测试文件不进 bundle，可以继续用 devDependencies。
- 改动依赖或 import 后，用无 `node_modules` 的副本验证：复制源码到临时目录、改 manifest id、让 contribute 提前返回，`paseo plugin add <目录>`，看到 "Plugin ready" 后 `paseo plugin remove` 并删除目录。
- 总览是 `addScreen`（id `ledger-overview` 不变），`range` 放在 screen params 里（`today`/`7d`/`30d`/`all`，缺省 all）。screen props 没有 setParams；切换范围用 `client.openScreen`（宿主 router.push，会产生历史记录），标题函数随 params 变化。
- 侧边栏是 `addSidebarFooterItem` + `SidebarRow`，trailing 显示今日费用。"今天"按客户端本地午夜计算，以 ISO `since` 传给 `ledger.overview`；服务端按 `Date.parse(endedAt)` 过滤 read-model 行，不在服务端猜时区。
- `addSurface` / `addSidebarItem` / `openSurface` 已弃用，不要再用。不接 `registerUsageSource`（那是订阅额度窗口，不是逐轮 usage；用户已决定不放进 Usage 面板）。
- 0.11.1 仍未公开 cache-write 和 provider 内部子代理 usage。

## 发布

仓库 `stv1024/token-ledger`。发版打 tag（如 `v0.1.1`）+ GitHub Release + `npm publish`（包名 `paseo-token-ledger`）。用户侧用 `paseo plugin add github:stv1024/token-ledger --ref <tag>` 安装（0.11 起不带 `github:` 前缀的 `owner/name` 会走官方 registry，且 registry 拒绝 `--ref`）。`DEVELOPMENT_PLAN.md` 是内部文档，已在 .gitignore 里，别发布。

官方 registry（`getpaseo/plugins`，记录 `plugins/stv1024/token-ledger.json`）固定一个 npm 版本。发布 npm 后，bot 每天 05:17 / 17:17 UTC 自动开 bump PR，维护者审核合并后才上线；不需要再提交 issue。`OVERVIEW.md` 是 registry 详情页，随包发布；registry 校验拒绝其中出现 `paseo plugin add`、`npm install`、`npm i`。manifest 的 `icon`（包内 PNG）和 `media` 文件必须列进 package.json `files`。registry 记录里的 `listing.*` 按字段覆盖 manifest。
