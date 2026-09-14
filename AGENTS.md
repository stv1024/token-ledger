# AGENTS.md — 开发调试速查

TokenLedger 是 Paseo v0.8 插件（id `token-ledger`）。**若存在 `AGENTS.local.md`（gitignore，本机专用），先读它——本机路径、工具链怪癖、测试 provider、账号事项都在那里，其内容优先于本文件。**

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

- 0.8 必须分离入口：`index.client.tsx` / `index.server.ts`，代码分别放 `client/`、`server/`、`shared/`。文件后缀不再划分边界；禁止跨端 import。manifest 声明 `requirements.paseo: ">=0.8.0 <0.9.0"`，SDK 固定 0.8.0。
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

## 发布

仓库 `stv1024/token-ledger`。发版打 tag（如 `v0.1.1`）+ GitHub Release，用户侧用 `paseo plugin add stv1024/token-ledger --ref <tag>` 安装。`DEVELOPMENT_PLAN.md` 是内部文档，已在 .gitignore 里，别发布。
