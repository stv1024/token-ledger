# OMP drain workaround 设计权衡记录

日期：2026-10-16  
背景：修复 issue-omp-turn-usage-settlement.md 中记录的"OMP 轮次结算丢失 usage"问题  
提交：0ac6d72

## 问题根源

Paseo 0.11.2 的两个异步通道无法对齐：

1. **timeline** 的 `turn_completed` 不带 usage（OMP 特有）
2. **agent_update** 的 `lastUsage` 快照在终止事件之后才异步到达（9–17ms 实测）
3. 快照里 `activeTurn` 仍然指向刚结束的轮（所以不能用"变 null"当 drain 信号）
4. usage 没变化时 OMP 不发最后一个快照（所以必须有超时后备）

## 当前方案（0ac6d72）

session scope 的 completed 轮先记 `open.ending`（持久化进 journal），延迟结算，在以下任一条件触发：

1. 收到第一个新的 usage 观察（`noteUsage`）
2. 下一轮开始（`streamTurn` 的 turn_started）
3. 2s 超时（`scheduleSettle`）
4. 插件停止或 agent 归档（`stopTracker` / `retireAgent`）

结算时的 status/endedAt 用 `ending` 记录的值，不被超时改写。

## 为什么不优雅

1. **状态机多了一层**：turn 生命周期从"open → closed"变成"open → ending → closed"（仅 session scope）。journal 要持久化 ending，恢复时要处理。
2. **结算触发点分散**：四个触发条件分散在三个函数里，改 turn 生命周期时要检查所有分支。
3. **超时是猜的**：2s 没有依据（只是"比 3s 轮询周期短，比异步 stats 读慢"），OMP 改行为或网络慢时会失效。
4. **两套语义共存**：Codex/Claude 立即结算，OMP 延迟结算，`tokenScope` 判断散布在多处。

## 考虑过但放弃的方案

| 方案 | 为什么不行 |
|---|---|
| 立即用已有观察结算 | 旧代码，丢最后一次调用或整轮为空 |
| 等 activeTurn 消失 | 源码证实最后快照发出时 activeTurn 还在，信号来得比 drain 早 |
| 只在下一轮开始时结算上一轮 | 最后一轮可能永远不结算，面板显示"进行中"会很怪 |
| 两段式结算，后续升级记录 | 与"磁盘原始值不重写"约束冲突，Timeline 也已发过 |
| Codex/Claude 也延迟，统一逻辑 | 它们的终止事件已带 usage，延迟纯属浪费，所有轮次晚 250ms 显示 |
| 标注"OMP 不保证准确"放弃修 | 对用户不诚实，plugin 已发布不能降级承诺 |

## 长远重构方向（如果上游修了）

**最理想**：Paseo 让 OMP 的 `turn_completed` 带上 usage（或新增 `turn_usage_finalized` 事件）。

届时可以**删除**：
- `open.ending` 字段和相关 schema
- `endLifecycleTurn` 函数
- `scheduleSettle` 和 `SESSION_DRAIN_MS`
- `noteUsage` / `streamTurn` 里的 `if (open.ending && ...)` 分支
- `observeEnd` 的 `scheduleSettle` 调用

**保留**：
- `tokenScope` 判断（这是语义区分，不是 workaround）
- journal 持久化逻辑（ending 字段可废弃但保留兼容读，不影响）
- `lastClosedTurnId` 防重放（这是所有 provider 都需要的）

重构后 OMP 回到和 Claude 一样的立即结算路径，代码复杂度回到 2026-10-15 以前的水平。

## 判断何时可以重构

监控信号：
1. Paseo release notes 提到 OMP turn_completed 带 usage 或相关修复
2. `@getpaseo/protocol` 的 `AgentStreamEventPayloadSchema` 里 `turn_completed` 的 `usage` 字段从 optional 变 required（对 OMP）
3. 实测 OMP 轮次的 `finalizeTurn` 里 `finalUsage` 不再为 null

届时翻出这份文档，按"长远重构方向"清单逐项删除 workaround 代码，跑测试，确认 OMP 实测记录的 source 从 `last_observation` 变成 `turn_usage`，即可完成清理。

## 当前方案的验收证据

- typecheck 通过，72/72 测试通过
- 新增 6 个确定性测试覆盖竞争时序（samples A/B、无重复计数、ending 恢复、stream 优先）
- 实测 OMP agent `16838577…`，2 次调用，最后调用 07:32:09.242，记录 endedAt 07:32:09.252，token 总和与原生日志一致
- `modelCalls=null`（不虚报快照数）

这个方案在**既有约束下**（磁盘不重写、turnId 非全局唯一、timeline 不回填、未知不估算）是能做到的最务实的。
