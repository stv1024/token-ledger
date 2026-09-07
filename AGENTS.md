# AGENTS.md — 开发调试速查

TokenLedger 是 Paseo v0.7 插件（id `token-ledger`）。**若存在 `AGENTS.local.md`（gitignore，本机专用），先读它——本机路径、工具链怪癖、测试 provider、账号事项都在那里，其内容优先于本文件。**

## 开发循环

```bash
node node_modules/typescript/lib/tsc.js --noEmit   # typecheck（等价 tsc --noEmit）
node --test src/aggregate.test.ts                  # 单测（Node 24 原生跑 TS）
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

- 单入口 `index.ts`：编译器把 `plugin.handle(...)` 语句从 client bundle 剥掉、`plugin.addXxx(...)` UI 注册从 server bundle 剥掉，`.client.*`/`.server.*` 的 import 同理。**contribute 函数体里的其他语句两端都会执行**，别放副作用。
- 服务端 contribute 只拿到 `{ handle }`；`paseo`（PaseoApi）只在 RPC handler 里注入，但它是子进程级单例——handler 里启动的订阅会常驻。tracker 靠 `addClientSide` 在客户端连接时打一发 ensure RPC 来启动。
- **wire 层 `agent_stream` 没有 `usage_updated`**：轮中 usage 走 `agent_update` upsert 快照（`lastUsage`/`activeTurn`），且必须先 `paseo.agents.list({ subscribe: {} })` 才会推送。turn 生命周期（started/completed/failed/canceled + turnId + 轮末 usage）走 `agents.ref(id).timeline.subscribe`。
- usage 语义（2026-09-04 实测）：Claude 轮末 usage 是**逐轮**汇总、`totalCostUsd` 是**会话累计**（所以记录里存 delta + raw 两份）；Codex 每次模型请求报一次 `last` 值，多请求轮靠去重求和。快照会把上一轮旧 usage 回放进新一轮——tracker 用 agent 级 `lastObservation` 基线挡掉。
- **Paseo 丢弃 `cache_creation_input_tokens`**（2026-09-05 从 app.asar 的 `providers/claude/agent.js` `buildResultUsage` ~1424 行验证）：`cachedInputTokens` 只映射 `cache_read_input_tokens`，cache write 只用于上下文窗口内部估算、不进 `AgentUsage`。后果：用户输入和工具结果（几乎全是 cache write，计费 1.25× input 价）在 IN 和 CACHE 两列都不可见，IN 通常只有零头（个位数~几十）；`costUsd` 仍准确（上游总额含 write）。pricing.ts 的分项估算按牌价直算，总额与估算的差额单列为 `otherUsd`（COST 列下方显示 `+$x.xx`）——不再 rescale 摊进分项。token 数本身的缺口需上游 Paseo 加字段，插件侧无法拿到。
- **input 语义因 provider 而异**（2026-09-05 从落库记录实测）：codex/OpenAI 系的 `inputTokens` **含** cached（如 input 213818 / cached 213252，真实新增仅 566）；Claude 的 input **不含** cache read。`semantics.ts` 维护按 provider（回退 model）匹配的语义表，归一化到"input = 未命中缓存的新输入"（Anthropic 式，信息不丢失）。磁盘 ledger.jsonl 永远存上游原始值，归一化只在读取/服务层做（store 的 summary、tracker 的 handleSync 和 inFlightFor），历史记录自动被正确重解读。新接 provider：跑一轮真实 turn → 看落库记录判断 input 是否含 cached → 往 SEMANTICS_TABLE 加一行 + 测试。未知 provider 原样透传，不猜。
- **turnId 不是全局唯一的**（2026-09-07 从 ledger.jsonl 实测）：Paseo 的 turnId 形如 `foreground-turn-N`，agent/daemon 会话重启后从 1 重新计数。任何以 `agentId:turnId` 当唯一键的地方都会跨会话冲突——曾导致面板 React key 重复、渲染出幽灵重复行。现在记录 id 拼入 `endedAt`（aggregate.ts），面板行 key 用 `seq`（兼容旧格式的历史记录）。新代码需要唯一键时同样别只用 turnId。
- **终止事件后快照可能回放 activeTurn**（同日实测，曾造成 3ms 内同一 turn 落库两条）：turn_completed 之后紧跟的 agent_update 快照仍带着刚结束的 turn，noteUsage 若据此重开 open turn，下个终止事件就会重复落库。tracker 用 `lastClosedTurnId` 挡掉（openTurn 时清除）。改 turn 生命周期逻辑时注意 timeline 事件流和快照流是两条异步通道，顺序无保证。

## 发布

仓库 `stv1024/token-ledger`。发版打 tag（如 `v0.1.1`）+ GitHub Release，用户侧用 `paseo plugin add stv1024/token-ledger --ref <tag>` 安装。`DEVELOPMENT_PLAN.md` 是内部文档，已在 .gitignore 里，别发布。
