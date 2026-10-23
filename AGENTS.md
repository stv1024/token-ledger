# AGENTS.md — 开发调试速查

TokenLedger 最低支持 Paseo v0.11.0，不设版本上限（id `token-ledger`，SDK 开发依赖固定 0.11.1；已验证宿主 0.11.1、0.12.0）。0.9.1–0.10.x 用户留在 v0.6.3。允许加载不代表所有未来版本均已实测；兼容策略与验证记录见 `docs/compatibility.md`。**若存在 `AGENTS.local.md`（gitignore，本机专用），先读它——本机路径、工具链怪癖、测试 provider、账号事项都在那里，其内容优先于本文件。**

## UI 设计理念

Avoid unnecessary secondary labels and descriptions. Let the layout do the explaining.

## 隐私红线

- **禁止发布 Stephen 私人网关的任何信息或数据**：网关名称、provider/model 名（含本机 provider 配置名）、价格表、汇率、额度、账号、端点，以及真实账本数据、agent/会话 ID、本机路径。范围包括源码、测试、文档、截图、commit message、PR/issue/Release 文本和 npm 包。
- **新功能不能依赖私人网关**：只针对公开 provider/harness 的已验证语义设计；不内置私有价格种子或固定汇率。测试和文档用合成数据（如 `acme-web`、`openai/gpt-5`）。
- 私人网关只用于本机实测，相关事项写在 `AGENTS.local.md`；含真实数据的调研笔记放 `docs/private/`（已 gitignore）。提交前 `git grep -i` 检查网关名和本机路径，发版前用 `npm pack --dry-run` 核对包内容。

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
- **Paseo 0.11.2 仍丢弃 cache creation**：Claude `buildResultUsage` 只映射普通输入、cache read、输出与 SDK 报告费用。缺失不等于零；命中率必须有完整分母。`costUsd` 只是运行器报告费用，不保证等于网关实际扣款；分项估算残差不得反推 write token。
- **输入口径只按已验证 harness，不按模型回退**：Codex input 包含 read/write；Claude 和 OMP input 已与缓存分开。`usageSemantics(provider)` 不接受 model。RPC 的 IN 是减掉 read 和已知 write 的未缓存输入，write 缺失时 Codex IN 仍可能含未分类写入；未知 provider 原样显示并排除轮次合计。磁盘原始值不重写。
- **自定义 provider 按 `extends` 认 harness**（v0.8.1）：`server/providers.ts` 用 `paseo.config.get()`（0.11.0 起有）读 `providers[name].extends`，30 秒节流，失败保留按名识别；`harnessOf()` 沿链解析。新记录存 `harness`，旧记录不回填，以后配置变化不改写已有记录的解读。语义用 harness，价格匹配（`providers` 作用域）仍用真实 provider 名。
- **`customPricesOverride` 只让 `pricing.json` 价格替换报告费用**：OpenRouter/内置价格永不替换，因为它们缺 cache write，报告的 Claude 费用包含它。报告值始终留在磁盘。
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
- `providerSemantics` 区分 Claude turn、Codex request、OMP session/branch 和 unknown；`tokenScope` 在读取旧账本时按已验证 harness 补足解释。session/unknown 只作为快照显示，不做轮差、不计入轮次或日期范围合计、不估算单轮费用。`ledger.sync.usageSnapshot` 保留迟到的闭轮/idle 观察，不能据此重开一轮；无 epoch/终值归属时不猜测真实轮增量。
- Codex `requests` 用于逐请求价格档位；缺字段时整个对应分项保持未知，原请求仍保留。价格匹配保留完整 ID，标准 Claude 纯数字版本仅兼容点号/连字符，其他差异使用显式 aliases。旧的 namespace/context/provider 折叠只用于提示迁移，不能选价；可能的旧覆盖价失配或多义匹配阻止参考价回退，并通过 pricingWarning/pricingWarningTurns 在 UI 提示。provider scope 仅匹配 provider，配置读回后自动清除已解决的提示。用户文件不重写，无内部价格种子或固定汇率。
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
- 改动依赖或 import 后，用无 `node_modules` 的副本验证：复制源码到临时目录、改 manifest id、让两端 contribute 提前返回 `() => {}`（宿主要求 cleanup 函数，裸 return 会被拒绝），`paseo plugin add <目录>`，看到 "Plugin ready" 后 `paseo plugin remove` 并删除目录。
- 总览是 `addScreen`（id `ledger-overview` 不变），`range` 放在 screen params 里（`today`/`7d`/`30d`/`all`，缺省 all）作为**初始**范围；屏内切换是组件 state。screen props 没有 setParams，`client.openScreen` 是宿主 router.push——每调一次叠一条历史，所以屏内切换不能走导航（曾导致点 range 按钮刷屏历史记录）；标题用静态字符串，params 派生标题在本地切换后会过期。
- 侧边栏是 `addSidebarFooterItem` + `SidebarRow`，trailing 显示今日费用。"今天"按客户端本地午夜计算，以 ISO `since` 传给 `ledger.overview`；服务端按 `Date.parse(endedAt)` 过滤 read-model 行，不在服务端猜时区。
- `addSurface` / `addSidebarItem` / `openSurface` 已弃用，不要再用。不接 `registerUsageSource`（那是订阅额度窗口，不是逐轮 usage；用户已决定不放进 Usage 面板）。
- OMP 轮末 drain（0.11.2 源码验证）：`turn_completed` 不带 usage，先于 poller 的最终 `usage_updated` 发出；最终快照仍带 activeTurn，且 usage 未变化时不发。所以 session scope 的 completed 轮先记 `open.ending`（随 journal 恢复），在第一个新观察、下一轮开始或 2s 超时时结算，状态和 endedAt 取 ending。失败/取消立即结算。session/unknown 的 `modelCalls` 为 null（快照数不是调用数）。
- 0.11.2 的 cache-write、Codex 内部子代理 usage、OMP branch epoch 缺口仍在。OMP 统计已包含部分子代理，不能无条件再叠加。徽标使用 Session token snapshot，不以 unknown 代替已知快照；未知 scope 不求 token 总数。历史 Timeline 缺少 scope 元数据时只声明元数据缺失，不声明账本排除。更新后重载客户端以使用新字段。

## 0.12 适配约束

- **background workspace 默认被过滤**：0.12 的 `agents.list` / `workspaces.list` 及其 update 流不带 `filter.includeBackground` 时排除 background workspace，被过滤的 agent 以 `remove` 推送。MCP 新建 workspace 会继承调用方的 background，子 agent 常在其中。所有目录 list 都经 `shared/background.ts` 的 `includingBackground`；同一订阅的翻页必须沿用 open 时的 filter。0.12+ 客户端 SDK 连旧 daemon 会抛 "Update the host to use background workspaces."，回退为无 filter，不抬高最低版本。
- **`remove` 不等于删除**：tracker 收到 update 流的 `remove` 后先 `agents.ref(id).refresh()` 确认（按 ID 不受 background 过滤），agent 仍在则保留 open turn，确认消失才 retire。
- CLI 的 `paseo agent archive <id>` 找不到 background agent；测试后用 `paseo workspace archive` 和 `paseo project delete` 清理。
- 0.12 编译器允许 type-only import `@getpaseo/protocol/*` 子路径，但最低版本仍是 0.11，上面的 import 禁令不变。0.13 将弃用 `/client/react-native`（改用 `/client/ui`），届时再迁移。

## 截图

发布用截图不能出现真实 agent 标题、workspace 或项目名。用独立 demo daemon 和合成数据：

- 新建 home 目录，config 只写 `daemon.listen`（换端口）、`daemon.relay.enabled: false`、`daemon.cors.allowedOrigins`（静态服务 origin）、`pluginsEnabled: true`。0.11.2 的 relay/cors 在 daemon 下，不在根级。**不要**复制 `~/.paseo/config.json`（含 provider 密钥）。`paseo daemon run --home <dir>` 前台运行，用 `paseo daemon stop --home <dir>` 只停它，不碰主 daemon。演示 OMP 需在隔离配置中启用，并用 provider.env.PI_CODING_AGENT_DIR 指向临时目录，避免继承用户的 disabledProviders。
- `paseo project create <dir> --home <home>`、`paseo workspace create --path <dir> --isolation local --title <name> --home <home>` 建项目和 workspace。agent 记录直接写 `agents/<cwd 去冒号、分隔符换成 ->/<uuid>.json`（daemon 启动时读），账本写 `plugins/token-ledger/ledger.jsonl`，然后 `paseo plugin add <仓库目录> --home <home>`。
- Web 客户端在桌面安装目录的 `resources/app-dist`。静态服务时往 index.html 注入 `globalThis.__PASEO_INITIAL_DAEMON_CONNECTION__={listen:"127.0.0.1:<port>",useTls:false}`，用 puppeteer-core 截图。总览可直接打开 `/h/<serverId>/plugin/token-ledger/surface/ledger-overview?param.range=7d`。
- 截完停 demo daemon，删除 demo 目录。

## 发布

仓库 `stv1024/token-ledger`。发版打 tag（如 `v0.1.1`）+ GitHub Release + `npm publish`（包名 `paseo-token-ledger`）。用户侧用 `paseo plugin add github:stv1024/token-ledger --ref <tag>` 安装（0.11 起不带 `github:` 前缀的 `owner/name` 会走官方 registry，且 registry 拒绝 `--ref`）。`DEVELOPMENT_PLAN.md` 是内部文档，已在 .gitignore 里，别发布。

官方 registry（`getpaseo/plugins`，记录 `plugins/stv1024/token-ledger.json`）固定一个 npm 版本。发布 npm 后，bot 每天 05:17 / 17:17 UTC 自动开 bump PR，维护者审核合并后才上线；不需要再提交 issue。`OVERVIEW.md` 是 registry 详情页，随包发布；registry 校验拒绝其中出现 `paseo plugin add`、`npm install`、`npm i`。manifest 的 `icon`（包内 PNG）和 `media` 文件必须列进 package.json `files`。registry 记录里的 `listing.*` 按字段覆盖 manifest。
