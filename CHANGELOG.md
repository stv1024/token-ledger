# Changelog

## v0.7.0 (2026-10-09) — Paseo 0.11 screens and sidebar

Requires Paseo **0.11.0 or newer**. Paseo 0.9.1–0.10.x users should stay on `v0.6.3`. Existing ledger records and custom prices remain compatible.

- Make the overview a Paseo 0.11 screen. Pick Today, Last 7 days, Last 30 days, or All time; the range is a screen param, so links and the header title follow it. A range lists agents with turns that ended in it and agents with a turn in flight. Day ranges start at local midnight on the device that shows them.
- Replace the sidebar header link with a sidebar footer row that shows today's cost (or tokens when no price is known) and an activity icon while a turn runs. The row opens the overview on Today.
- Fix `github:` and `git:` installs on Paseo 0.11, which failed with `Could not resolve type dependency "@getpaseo/client"`. Shipped code now derives Paseo client types from the host SDK, so `@getpaseo/client` and `@getpaseo/protocol` are development dependencies only. npm installs need no dependencies either.
- Use `github:stv1024/token-ledger` for Git installs; since Paseo 0.11, a bare `owner/name` source means the plugin registry.
- Pin SDK development dependencies to 0.11.1 and check CI against 0.11.0, 0.11.1, and the latest SDK. See the [compatibility notes](docs/compatibility.md).
- Prepare the [Paseo plugin registry](https://paseo.sh/plugins/stv1024/token-ledger) listing: the manifest declares the display name, a PNG icon, and screenshots, and the package ships an author `OVERVIEW.md` for the listing page.

## v0.6.3 (2026-09-30) — Paseo 0.10.2 compatibility

- Allow Paseo `>=0.9.1` without an upper version limit. The previous `<0.10.0` ceiling prevented loading on Paseo 0.10.2 even though the APIs used by TokenLedger remain compatible. Keep SDK dependencies pinned to 0.9.1 and document tested hosts separately from the allowed range.
- Check types and the existing test suite against the minimum SDK, 0.10.2, and the latest published SDK in CI, including a weekly check for upstream changes. See the [compatibility policy](docs/compatibility.md).

## v0.6.2 (2026-09-29) — fix npm installation

- Fix `paseo plugin install npm:paseo-token-ledger` failing with `Could not resolve type dependency "@getpaseo/client"`. Paseo resolves type-only imports at install time and npm installations omit devDependencies, so `@getpaseo/client` and `@getpaseo/protocol` are now runtime `dependencies` (type-only; nothing is bundled). Plugin behavior is unchanged. Use 0.6.2 or later from npm; 0.6.1 is deprecated there.

## v0.6.1 (2026-09-29) — npm and paseo.cafe distribution

Plugin behavior is unchanged from v0.6.0; still requires Paseo **0.9.1–0.9.x**.

- Publish on npm as `paseo-token-ledger` (`paseo plugin install npm:paseo-token-ledger`) and list on [paseo.cafe](https://paseo.cafe/plugins/token-ledger). The package ships only the plugin sources (`paseo-plugin.json`, entries, `client/`, `server/`, `shared/`), without tests.
- Add package metadata (description, license, repository, keywords); move README screenshots to `images/`; add a Limitations section to the README.
- Add a 20-second promo video (linked from the README, attached to the v0.6.0 release) and its reproducible Remotion source in `promo/`.

## v0.6.0 (2026-09-23) — Paseo 0.9.1 compatibility and recovery

Requires Paseo **0.9.1–0.9.x** on both the daemon and the app. Paseo 0.8 users should stay on `v0.5.1`; existing ledger records and custom prices remain compatible. See the [release and upgrade notes](docs/releases/v0.6.0.md).

- Target Paseo 0.9.1–0.9.x and pin all Paseo SDK packages to 0.9.1. Replace fixed catalog subscription IDs with host-assigned handles, reconcile restored paginated snapshots, and await subscription release on cleanup.
- Recover from post-establishment timeline errors with bounded retries. Preserve delivery gaps through checkpoints, mark missing terminal outcomes as unknown, and avoid attributing cumulative costs across unobserved turns.
- Add host-scoped native settings for Timeline summaries, OpenRouter/built-in reference pricing, and active/idle polling frequency. Settings changes invalidate enriched pricing without rewriting ledger history.
- Show the current turn's estimated cost in the in-flight card and include it in the composer pill's running total, with an explicit approximation mark.
- Verify standard Claude model prices against Anthropic's 2026-09-23 price table, including Opus 5.5; match explicit model versions so unverified models or Fast/Batch suffixes do not inherit older prices. Custom prices and reported costs retain priority.
- Add plugin metadata and document Paseo 0.9 update commands. Cache-write and provider-internal descendant usage gaps remain in Paseo 0.9.1.
- Add optional cache-write counts throughout aggregation, checkpoints, ledger records, RPCs, and UI, with an independent `cacheWrite` price and OpenRouter cache-write price ingestion. Keep old records/prices compatible and reported costs authoritative.
- Separate known writes from inclusive input, include them in prompt-size tiers and cache ratios, and preserve richer observations when another channel omits write detail. Pass raw usage into live cost estimation to avoid normalizing input twice.
- Document the public API gaps for cache writes and provider-internal subagents, rechecked on Paseo 0.9.1, with upstream requirements for complete usage, lineage, request identity, and cost scope. These missing usage streams are not recovered by this release.

## v0.5.1 (2026-09-16) — iOS plugin loading fix

- Fix iOS plugin activation: replace the client-side `PanelPlacement` class with a closure factory so the dynamically loaded bundle avoids Hermes-incompatible class syntax.
- Use Paseo's plugin-hosted `ScrollView` in the panel and overview for compatible scrolling within mobile sheets.

## v0.5.0 (2026-09-14) — Paseo 0.8 optimizations

- Preserve open turns, provider sessions and billing baselines through plugin reloads with an atomic journal and idempotent append recovery. Reconcile lifecycle hooks with usage-carrying timeline events.
- Share panel/pill queries, invalidate from agent updates, reduce idle polling, and omit unchanged history from responses. Cache enriched ledger rows and complete paginated agent/workspace catalogs.
- Separate harness aggregation/cost contracts from model token conventions. Retain raw unknown-scope cost and price observed Codex requests independently across prompt-size tiers.
- Serve local prices before background OpenRouter refresh; refresh expired caches and validate tier ordering. Pick up valid local pricing edits without reload.
- Scope panel placement to mounted per-agent layouts and share measured-width compact rendering with the overview.
- Append one passive Timeline usage summary after durable settlement, with stable-ID bounded retries and no historical backfill.

## v0.4.0 (2026-09-14) — Paseo 0.8 migration

- Split runtime entries and client/server/shared directories; pin the SDK to 0.8.0 and declare 0.8.x compatibility.
- Migrate composer pills to native button descriptors and update/remove handles.
- Start tracking through daemon lifecycle hooks for CLI/headless turns; await timeline subscription readiness and handle history replacement events.
- Make turn starts idempotent across snapshot/stream ordering, reject stale terminal events, and avoid billing replayed usage on failed/canceled turns. Preserve provider session identity when available for cumulative billing.
- Traverse agent/workspace catalog pages, serialize ledger appends and retention, and drain pending writes on cleanup.
- Preserve existing v1 history and the local pricing/estimated-cost work; add regression tests for lifecycle ordering, pagination, persistence, and RPCs.

## v0.3.1 (2026-09-08)

- Fix: pressing the composer pill (or the command center entry) on compact layouts (phone) did nothing. The v0.3.0 explorer placement assumed the host throws when no explorer pane exists; it doesn't — it silently opens the panel into a side pane the compact UI never renders. Placement is now decided up front from the host's `layout.compact` hint: main pane on compact, explorer side pane otherwise.
- Panel layout now adapts to the measured pane width instead of the host's `layout.compact` hint (which doesn't reflect the sidebar's actual width). Below 410px the TURNS table and summary row switch to tight column widths/gaps so the default sidebar pane (~320px) fits without clipping the COST column or wrapping the time/duration text. The threshold is set to the width the roomy layout actually needs, so there is no in-between state that overflows.

## v0.3.0 (2026-09-07)

- Docs: README now opens with a screenshot of the per-agent panel (`docs/screenshot-panel.png`).
- Fix: ghost duplicate rows in the TURNS table. Paseo turnIds (`foreground-turn-N`) restart per session, so `agentId:turnId` record ids collided across restarts and duplicate React keys made rows render twice. New records include `endedAt` in the id; rows are keyed by `seq` so pre-existing records display correctly too.
- Fix: a stale agent snapshot arriving right after a turn's terminal event could reopen the just-closed turn and persist it twice (observed 3ms apart). The tracker now ignores snapshots whose `activeTurn` matches the last closed turnId.
- TURNS rows now show their per-agent turn number (`#N`, newest = the summary `turns` count), and the in-flight card reads `Turn #N in progress`. The list stays newest-first; the numbers make the direction self-evident and map rows to conversation turns.
- Opening the panel (composer pill or command center) now targets the explorer side pane (`location: "explorer"`), so the agent view stays visible and the ledger opens beside it. Compact layouts without an explorer pane fall back to the previous main-pane placement.

## v0.2.0 (2026-09-04)

- Composer pill: each agent session shows a compact usage pill (`$cost · ctx %`) next to its composer; pressing it opens the TokenLedger panel for that agent. Registered per live agent, removed when the agent closes.
- Global overview: sidebar item + surface listing per-agent usage grouped by workspace, with live-turn indicator and tap-to-open-agent navigation. New `ledger.overview` RPC aggregates the shared ledger by agent and enriches rows with agent/workspace metadata.
- Panel now shows which agent it is bound to (title · model) in the Session header, and a context-window bar when idle (last known usage, via new `ctx` field on `ledger.sync`).
- New "Open TokenLedger Overview" command in the command center.

## v0.1.0 (2026-09-04)

- Initial release: per-turn token usage tracking for Paseo agents.
- Agent panel with session summary, in-flight turn card (context-window bar), and turn history.
- Local JSONL persistence (last 2,000 turns) under `~/.paseo/plugins/token-ledger/`.
- Honest data-quality marks (`exact` / `partial` / `unavailable`); no estimation.
