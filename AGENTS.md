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
- 原则：只呈现上游报告的数字，**永不估算**；quality 标 `exact`/`partial`/`unavailable`。

## 发布

仓库 `stv1024/token-ledger`。发版打 tag（如 `v0.1.1`）+ GitHub Release，用户侧用 `paseo plugin add stv1024/token-ledger --ref <tag>` 安装。`DEVELOPMENT_PLAN.md` 是内部文档，已在 .gitignore 里，别发布。
