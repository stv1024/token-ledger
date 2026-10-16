# Issue：OMP 轮次结算丢失/滞后 usage 快照（研究与修复交接说明）

状态：已修复（见 §8）· 发现日期 2026-10-16 · 发现方式：审计 agent `2b21c659-14fa-454c-b4b6-00fd33e9c4b8`（Paseo 0.11.2，provider `omp`，model `owtoken/mimo-v2.6-pro`）的 token ledger 记录，与 omp 原生 session 日志逐调用比对。

## 1. 现象

OMP 轮次的 ledger 记录经常**赶不上最后一个模型调用的 usage**，表现为两种形态：

1. **记录停在上一个快照**：`source=last_observation`，数值只覆盖到本轮倒数第二次调用（甚至更早），轮次末尾的调用被静默丢掉。
2. **整轮空记录**：`source=none, quality=unavailable, modelCalls=0`，token/cost 全为 `null`，但该轮实际发生过带 usage 的模型调用。

## 2. 实证（审计样本，账本 vs 原生 session 真值）

真值来源：`C:\Users\PC\.omp\agent\sessions\--D--projects-motion-lab--\2026-10-16T05-57-12-258Z_01a14349-2fc2-74e4-983e-e57369a51f4f.jsonl`，
其中 assistant 消息逐调用携带 `usage = { input, output, cacheRead, cacheWrite, totalTokens, cost }`（`cacheRead` = cached input）。
账本来源：`~/.paseo/plugins/token-ledger/ledger.jsonl`。

### 样本 A — 轮次 `83010c14`（记录 id `d5eaf749-8896-4964-97e6-46713e9718c2`）

账本记录：`05:57:12.377 → 05:57:49.215, source=last_observation, quality=partial, modelCalls=2,
input=2078, cached=9984, output=484, sessionCostUsd=0.00943752`

真值（本轮 2 次模型调用）：

| 调用时间 | input | cacheRead | output | cost |
|---|---|---|---|---|
| 05:57:28.080 | 2078 | 9984 | 484 | 0.00943752 |
| 05:57:49.198 | 673 | 12032 | 619 | 0.00609396 |

记录数值（2078/9984/484，cost 0.00943752）**恰好等于第 1 次调用后的累计快照**，第 2 次调用完全未反映。
第 2 次调用的 usage 时间戳（05:57:49.198）距轮次结算（05:57:49.215）只有 **17ms**。

### 样本 B — 轮次 `afd69f4c`（记录 id `67f1e246-aa14-427d-b5e6-1506528edda2`）

账本记录：`05:58:30.208 → 05:58:45.631, source=none, quality=unavailable, modelCalls=0`，全部计数为 `null`。

真值：本轮含 1 次模型调用，05:58:45.622，usage `input=455, cacheRead=12672, output=307`。
调用结束距轮次结算仅 **9ms**。本轮账本为零，但调用真实存在。

### 交叉验证（说明快照本身是准的）

该 session 前 10 次调用逐调用求和 = `input 30131 / cached 165632 / output 4091`，
与 agent 元数据 `C:\Users\PC\.paseo\agents\D-projects-motion-lab\2b21c659-....json` 的 `lastUsage` 逐字段相等。
即 OMP 的 `lastUsage` 是**精确的 session 累计值**；问题不在 usage 数据本身，而在**结算时机**。

## 3. 机制分析（对应代码）

数据流（`server/turns.ts`、`shared/aggregate.ts`）：

- 观测（observation）唯一来源是 agent 快照的 `lastUsage`，由 `noteUsage()` 收集进 `open.observations`；
  与 `state.lastObservation` 做 `sameTokens` 去重——**重复的旧快照不入列**。
- 轮次终止事件到达时 `closeTurn()` **立即**用已收集的 observations 调 `finalizeTurn()` 落库；
  `finalUsage` 取自终止事件本身，而 OMP 的终止事件不带 usage → 降级链落到
  `observations.at(-1)`（`last_observation`）或空（`none`）。
- `closeTurn` 之后到达的快照被有意丢弃（`noteUsage` 注释 "Cumulative/unknown late observations remain visible as snapshots only"，
  另有 latest-snapshot card 展示）。**没有结算后的补齐/升级机制。**

结论：**timeline 事件流与 usage 快照流是两条异步通道，顺序无保证**（仓库 AGENTS.md 已记录同类问题），
而轮次结算不等待 usage 快照的"最终排空"（final drain）。两个样本的 9ms/17ms 时间差正是这个竞争窗口。

附带问题：`modelCalls: observations.length`（`aggregate.ts`）对 OMP 而言数的是**快照数，不是模型调用数**。
样本 A `modelCalls=2` 只是巧合（快照数恰好=调用数，但数值只覆盖 1 次调用）；样本 B `modelCalls=0` 而真值是 1 次调用。

## 4. 影响面（ledger.jsonl，截至 2026-10-16，共 2005 条）

- provider `omp`：`last_observation` 146 条（全部 modelCalls≥1，quality 全为 partial），
  `none` 23 条（其中 status=completed 18 条）。**OMP 没有任何一条 exact 级别记录。**
- 其他 provider 的 `completed+none`（可能另有原因，不在本 issue 范围）：deepseek-harness 33、claude-tokenrouter 3、kimi-tokenrouter 2。
- 注意设计现状：`providerSemantics('omp')` = `{ tokens: 'session', cost: 'unknown' }`，
  OMP 的 session 累计值本来就**不计入轮次合计/日期区间合计**（`tokenScope: 'session'`，见 README/OVERVIEW）。
  所以账面金额没有因此错算；损失的是**轮次级归因**（panel 的 Turn history 行显示不全或显示空）。

## 5. 研究问题（修复 agent 需要回答）

1. Paseo 0.11.2 的公开插件 API（见 `docs/paseo-usage-api.md`）现在能否提供 OMP 的
   per-turn / per-request usage 或终止事件附带 usage？若能，直接走 `turn_usage` 路径。
2. 若不能：结算是否应该做 **final drain**——终止事件到达后短暂等待（或等到
   `activeTurn` 消失且快照时间戳晚于最后一次调用）再 `closeTurn`？
   延迟落库对 checkpoint/恢复逻辑（`tracker-state.json`、`lastClosedTurnId` 防重放）有什么影响？
3. 或者**两段式结算**：先落库，末快照到达后升级记录。与既有约束"磁盘原始值不重写"冲突吗？
   （旧账本里存在 `turnId:endedAt` 后缀的修订 id 形态，可评估该模式。）
4. `modelCalls` 在 session/unknown scope 下的语义要不要修正（快照数≠调用数），避免误导。
5. 快照是精确累计值（§2 已验证），同一 session/branch epoch 内首尾差值即可还原轮次增量。
   但 `semantics.ts` 注释警告：OMP 分支视图总量可回退、无 branch epoch、无 final-drain 顺序保证。
   **在拿到 epoch 证据之前不要对累计值做差分归因**——这是设计红线，先解决观测到的竞争，再评估差分。

## 6. 建议验收标准

- 复现：构造/捕捉"终止事件先于末次 usage 快照到达"的时序（可用现有样本 A/B 的事件序列做回归用例），
  修复前记录缺末次调用或整轮为空，修复后记录覆盖到末次调用（或显式 `usageGap` 标记，不得静默丢数）。
- `modelCalls` 不再把快照数当调用数虚报（或改名/留空）。
- 不重复计数：相邻轮次不得都吸收同一累计快照；OMP 数值仍不进入轮次合计（scope 语义不变）。
- 既有测试全绿（`shared/aggregate.test.ts`、`server/turns.test.ts`、`server/tracker.test.ts`、`server/recovery.test.ts`）；
  新增确定性单测覆盖该竞争时序。
- 尊重仓库 AGENTS.md 既有约定：turnId 非全局唯一、终止事件后快照可能回放 activeTurn、时间线不回填、未知不估算。

## 7. 验证用真值提取方法

逐调用 usage（真值）：

```python
import json
p = r"C:\Users\PC\.omp\agent\sessions\<slug>\<startTs>_<sessionId>.jsonl"
for line in open(p, encoding="utf-8"):
    o = json.loads(line)
    if o.get("type") == "message" and o["message"].get("role") == "assistant" and o["message"].get("usage"):
        u = o["message"]["usage"]
        print(o["timestamp"], u["input"], u["cacheRead"], u["cacheWrite"], u["output"], u["cost"]["total"])
```

- session 累计快照（对照）：`~/.paseo/agents/<project>/<agentId>.json` → `lastUsage`。
- 账本：`~/.paseo/plugins/token-ledger/ledger.jsonl`，按 `agentId` 过滤。
- 已知可复算不变量：同一 session 内逐调用 usage 求和 == 末次 `lastUsage`（样本 session 已验证）。

## 8. 修复记录（2026-10-16）

§5 结论：
1. 不能。0.11.2 协议没有 `usage_updated` 推给插件；OMP 的 `turn_completed` 不带 usage（`agent/providers/omp/agent.js` `completeTurn`）。
2. 采用 final drain。`OmpUsagePoller.completeTurn()` 异步读 stats 后才发 `usage_updated`，此时 `activeTurnId` 仍指向刚结束的轮；usage 未变化时不发。
   因此 session scope 的 completed 轮记 `open.ending`，在以下任一条件下结算：第一个新观察快照、下一轮开始、2s 超时、插件停止/agent 退役。
   `ending` 随 journal 持久化；结算的 status/endedAt 取 ending，不被超时或中断改写。`lastClosedTurnId` 防重放不变。
3. 不采用两段式结算。记录 id 为稳定 UUID，磁盘记录不重写。
4. `modelCalls` 在 session/unknown scope 下为 null（新记录写 null，旧记录读时归一为 null）。
5. 未做累计差分。OMP 记录仍是 session 快照，不计入轮次合计，`costUsd` 仍为 null。

实测：OMP agent `16838577…` 一轮 2 次调用，最后调用 07:32:09.242，记录 endedAt 07:32:09.252，`input=38860/output=194` 与原生日志逐调用求和相等。
