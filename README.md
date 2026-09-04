# TokenLedger

Per-turn LLM token usage for [Paseo](https://paseo.sh) agents — an agent panel that records what each turn actually consumed, keeps a local history, and never guesses.

一个为 Paseo 提供**按轮（agent turn）**统计 token 用量的插件：面板实时显示进行中一轮的状态，每轮结束后固化一条账目，历史保存在本机。

## What it shows

- **Session summary** — total turns, input / cache / output tokens, and cost (only when the provider reports one).
- **Turn in progress** — elapsed time, running token counts when available, and a context-window bar.
- **Turn history** — one row per finished turn: status, time, duration, tokens, cost, and a data-quality mark.

## Install

```bash
git clone https://github.com/<owner>/token-ledger
cd token-ledger
npm install
paseo plugin install /absolute/path/to/token-ledger
```

Plugins must be enabled on the daemon (Settings → Plugins, or `pluginsEnabled: true` in `~/.paseo/config.json` followed by `paseo reload`). Plugins are trusted, unsandboxed code — read the source before installing, including this one.

Open any agent and pick the **TokenLedger** panel. Recording starts as soon as a Paseo client connects to the daemon, not only when the panel is open.

## How turns are measured

A "turn" is one user message through to `turn_completed`, `turn_failed`, or `turn_canceled` — potentially spanning many model calls. TokenLedger only reports what the provider reported; it never estimates tokens or prices:

| Situation | Value used | Quality |
| --- | --- | --- |
| Provider reports a whole-turn aggregate at turn end (Claude) | used as-is | `exact` |
| Provider reports per-request usage during the turn (Codex) | distinct observations summed | `partial` (shown as `≈`) |
| Only a single mid-turn observation | that observation | `partial` |
| Nothing reported | nothing shown | `unavailable` |

Cost: some providers report a cumulative session cost. When the reported value is monotonically non-decreasing across turns, the per-turn delta is attributed to the turn; the raw reported value is always kept in the record (`sessionCostUsd`).

## Data & privacy

- Records only usage metadata: timestamps, agent ID, provider, model, token counts, cost, status, duration, quality. **Never** prompts, responses, tool arguments, file paths, or credentials.
- Stored locally as JSON Lines at `~/.paseo/plugins/token-ledger/ledger.jsonl` (respects `PASEO_HOME`).
- Retention: the most recent 2,000 turns; older records are trimmed with an atomic rewrite.
- No network calls, no telemetry, no accounts. History does not sync between machines.

## Support matrix (v0.1)

| Provider | Tokens | Cost |
| --- | --- | --- |
| Claude / claude-* variants | per-turn aggregate (`exact`) | reported |
| Codex / codex-* variants | summed per-request (`partial`) | usually absent |
| Other providers (OpenCode, Pi, ACP harnesses) | whatever they report; `unavailable` when silent | usually absent |

## Development

```bash
npm install
npm run typecheck
npm test                      # node --test, no extra deps
paseo plugin reload token-ledger
paseo plugin logs token-ledger
```

Layout: `index.ts` registers everything; `src/aggregate.ts` is the pure aggregation core (unit-tested); `src/tracker.server.ts` subscribes to agent streams on the daemon; `src/store.server.ts` is the JSONL store; `src/panel.client.tsx` is the React Native panel.

## License

MIT
