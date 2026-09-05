# Changelog

## Unreleased

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
