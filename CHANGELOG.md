# Changelog

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
