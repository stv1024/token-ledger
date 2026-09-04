# Changelog

## v0.1.0 (unreleased)

- Initial release: per-turn token usage tracking for Paseo agents.
- Agent panel with session summary, in-flight turn card (context-window bar), and turn history.
- Local JSONL persistence (last 2,000 turns) under `~/.paseo/plugins/token-ledger/`.
- Honest data-quality marks (`exact` / `partial` / `unavailable`); no estimation.
