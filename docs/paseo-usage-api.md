# Upstream request: complete usage accounting through the Paseo plugin API

Status: submitted as follow-up comments in existing upstream Discussions on
2026-09-22, using `stv1024`; no maintainer acceptance or implementation is implied.

- [Cache creation counts — discussion #4623](https://github.com/getpaseo/paseo/discussions/4623#discussioncomment-18550901).
- [Descendant usage and attribution — discussion #4660](https://github.com/getpaseo/paseo/discussions/4660#discussioncomment-18550906).
- [2026-10-14 follow-up: OMP cache creation and input conventions](https://github.com/getpaseo/paseo/discussions/4623#discussioncomment-18924605).
- [2026-10-14 follow-up: final drain, branch epochs and attribution](https://github.com/getpaseo/paseo/discussions/4660#discussioncomment-18924607).

Paseo's [contribution policy](https://github.com/getpaseo/paseo/blob/b2ce2bcb83dd40bd91c32098c59221f0b52d7ffd/CONTRIBUTING.md)
directs missing extension points to Discussions. Existing threads covered both
workflows, so the follow-ups add plugin demand, source evidence, and acceptance
examples there rather than opening duplicate feature issues.

Verified against the Paseo 0.8.0 SDK and the installed Paseo 0.8 provider
implementation on 2026-09-22. Source locations were also rechecked on upstream
`main` at `b2ce2bcb83dd40bd91c32098c59221f0b52d7ffd`; that checkout was inspected,
not run. The posted comments link directly to the corresponding source lines.

TokenLedger uses only the public `PaseoApi` supplied to plugins. It does not read
provider transcripts, connect to private daemon transports, or query billing
gateways. The issues below affect provider/harness integration, independently
of which API gateway supplies the model.

Rechecked on 2026-09-23 against the installed Paseo 0.9.1 app and the published
0.9.1 SDK: `AgentUsage` still has no cache-creation count, Claude's result mapper
still omits it, and the Codex child-notification dispatcher still drops child
usage. The 0.9 nested-subagent hierarchy fix does not provide usage accounting.
The plugin's 0.9.1 compatibility and subscription recovery changes do not close
these upstream gaps.

Rechecked on 2026-09-30 against the installed Paseo 0.10.2 provider source and
published SDK: the same cache-creation and Codex child-usage gaps remain. See
the [compatibility review](compatibility.md) for the scope of this verification.

Rechecked on 2026-10-14 against installed 0.11.2, separately from public `main`
at `cafa04d3fbdbc7e4a3fe8f4d4bea80f15cd4a1d0`. The follow-ups above were posted
as `stv1024` and read back through GitHub; submission does not imply acceptance.
The public OMP usage poller was exercised in memory with synthetic statistics
and controlled promises, not by running the full upstream daemon:

- OMP maps `getSessionStats()` input/read/output/cost but drops `cacheWrite`.
  The installed OMP statistics are already cache-exclusive and aggregate the
  current session/branch, including some task-child usage.
- Completion can precede final usage; starting another turn can invalidate
  the pending final sample. Public snapshots do not preserve its turn identity.
  Require terminal drain or attributable late corrections, plus branch/reset
  epochs; subtracting adjacent snapshots is not a reliable per-turn contract.
- Context-only OMP stats become zero token/cost values in the current mapper.
  The plugin cannot distinguish those fabricated zeros from measured zero.
- Claude cache creation and Codex child usage remain omitted. Merged
  [#6703](https://github.com/getpaseo/paseo/pull/6703) and
  [#6106](https://github.com/getpaseo/paseo/pull/6106) improve context accounting,
  not the missing billing/usage contract. They are not duplicate bug reports.


## 1. Preserve cache creation usage

`@getpaseo/protocol/dist/agent-types.d.ts`, `AgentUsage`, currently exposes
`inputTokens`, `cachedInputTokens`, `outputTokens`, `totalCostUsd`, and context
window counts. It has no cache creation field.

In the provider implementation:

- `providers/claude/agent.js`, `buildResultUsage`: maps `input_tokens`,
  `cache_read_input_tokens`, `output_tokens`, and `total_cost_usd`. The upstream
  `cache_creation_input_tokens` count is not mapped.
- `providers/codex-app-server-agent.js`, `toAgentUsage`: maps the last request's
  `inputTokens`, `cachedInputTokens`, and `outputTokens`. Cache write usage is
  not mapped, including on builds that supply it.

Requested behavior:

1. Expose cache creation as an optional count, consistently across the provider
   adapter, wire validation, snapshots, terminal usage, and public SDK types.
   Missing means unavailable; explicit zero means measured zero.
2. Specify whether input includes reads and/or writes. Prefer one normalized
   contract, or expose the convention as provider metadata. A model name alone
   does not establish a harness's accounting contract.
3. Preserve separately billed cache lifetimes when available (for example,
   short-lived and long-lived creation). Define whether a total includes those
   subcategories, so clients do not add both. Do not infer a universal 1.25× rate.
4. Preserve reported total cost with its scope. More complete token counts must
   not cause clients to add cache creation charges to a total that already
   includes them.

TokenLedger now supports optional `cacheWrite` counts and prices internally.
Its reducer extension is named `cacheWriteInputTokens`; that is **not a claim
that this field exists in Paseo 0.8 or 0.9.1**. The final adapter mapping and counting
semantics must be checked against the upstream contract when it ships.

## 2. Expose provider-internal descendant usage and stable identities

Paseo catalog agents and provider-internal subagents are different entities.
TokenLedger already traverses and subscribes to the complete catalog. Listing
more catalog agents cannot recover usage that exists only in the provider's
internal threads.

In `providers/codex-app-server-agent.js`, `handleNotification` routes child
thread notifications to `dispatchSubAgentNotification`. That method does not
handle `token_usage_updated`; it reaches the default branch and returns. Root
usage is handled separately by `handleTokenUsageUpdatedNotification`.

The lower-level protocol has `ProviderSubagentDescriptorPayload` and subagent
timeline messages, but the descriptor has no usage, request identity, or cost
scope. The plugin's public `PaseoApi` also has no provider-subagent usage API.
A subagent title/status/tool-call relationship is insufficient for accounting.

Requested public contract (names below are proposals, not existing APIs):

| Fact | Purpose |
| --- | --- |
| Stable usage/request ID, scoped by provider session and thread | Deduplicate replay without collapsing equal-sized distinct requests |
| Provider session, thread, parent thread, root thread | Attribute nested work to its owning Paseo agent |
| Native turn and root turn, with a mapping to the Paseo turn | Associate late child usage with the correct user turn; tolerate reused turn IDs |
| Actual model for each billed request | Price child agents using their own model and request-sized tier |
| Token and cost aggregation scope | Distinguish request, turn, and session totals; distinguish own usage from descendant-inclusive usage |
| Stable event cursor and explicit coverage/gap status | Recover after reconnect/reload and report incomplete accounting honestly |

Expose a typed, paginated usage history and a matching subscription through
`PaseoApi`, including descendants. Stable IDs should work across both channels;
if entries can be corrected, supply an explicit revision/replacement contract.
The final turn event must either guarantee that usage has drained or allow late
usage to be attributed without guessing from timestamps or token amounts.

For reported costs, document currency, request/delta/cumulative scope, session
reset identity, and whether descendants are already included. In particular,
do not assume Claude's reported session cost excludes child work: adding child
charges without that contract could turn an undercount into double billing.

## Acceptance scenarios

- Inclusive input of 100, cache read of 60, and cache write of 30 normalizes to
  10 ordinary input tokens. Exclusive input of 10 with the same cache counts
  remains 10. Raw or normalized conventions must be explicit.
- Missing write count, zero write count, and positive write count remain
  distinguishable through JSON transport, SDK parsing, and history replay.
- At rates input=1, read=0.1, write=2 USD/MTok, those input components cost
  0.000076 USD. Per-request tiers use the complete 100-token prompt.
- Two different request IDs with identical token counts are both counted.
  Replaying either ID through another channel contributes nothing extra.
- One root request and requests from nested children appear once in the root
  conversation total. Children retain their own model and lineage.
- A parent total already containing descendants is not added to the same child
  charges. A separately catalogued child is not counted again under the parent
  in global totals.
- Child usage arriving after root completion or after reconnect still belongs
  to the original root turn. Reused `foreground-turn-1` IDs do not collide.
- Cumulative session cost resets only on a verified new provider session;
  resuming a session or reloading a plugin does not restart billing baselines.
- Providers without these capabilities expose missing/partial coverage, not
  fabricated zero usage. Existing providers and old plugin clients keep working.

## Plugin follow-up once the public contract exists

Map the confirmed write fields into TokenLedger's data model, then introduce
request-ID-based ingestion and parent/child attribution using the public usage
history/subscription. Persist identities before acknowledging ingestion, price
each request with its own model, and select one accounting scope for each
total. Keep the current snapshot path as an explicitly partial fallback.

Until then, verified turn/request tracking remains active. OMP session/branch
and unknown-scope observations are displayed separately and excluded from
per-turn costs and sums; late observations refresh the latest-snapshot card.
Coverage and unknown prices are explicit. Historical missing counts and
descendant charges cannot be reconstructed from the current public API.
