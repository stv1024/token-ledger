TokenLedger records the tokens and cost of each agent turn and keeps the history on the daemon host. It shows usage in four places: a ledger panel for each agent, a cost and context pill beside the message box, a sidebar footer row with today's cost, and an overview screen for all sessions.

The agent panel shows session totals, the turn in progress with its context window, and one row per finished turn with status, time, duration, input, cache and output tokens, cost, and a data quality mark. The pill shows the session cost and context use, with an activity icon while a turn runs, and opens the panel. The sidebar row opens the overview, which groups agents by workspace and filters to today, the last 7 days, the last 30 days, or all time. Day ranges start at local midnight on the device that shows them. After each finished turn, the plugin can add one short usage summary to the timeline.

Token counts come from the provider and are never invented. Claude reports a total for each turn, which is marked exact. Codex reports each model request, so the plugin adds the requests and marks the total as approximate. Other providers show the latest report, marked partial. When the provider reports a cost, that cost is shown. Otherwise the plugin estimates the cost, marked with ≈, from your prices in `pricing.json`, then OpenRouter reference prices, then a small built-in price table.

The plugin settings page on each host has four options:

- **Timeline summaries** turns the usage summary after each new turn on or off. Existing summaries stay.
- **OpenRouter reference prices** lets the plugin download the public model price list from `openrouter.ai` in the background and cache it for 24 hours. The request carries no tokens, prompts, or usage data. Turn it off to stop the download and stop using those prices.
- **Built-in fallback prices** controls estimates when no custom or OpenRouter price matches a model.
- **Refresh frequency** selects normal or relaxed polling. Live updates still refresh the views immediately.

The ledger is a JSON Lines file in the plugin data folder on the daemon host, `~/.paseo/plugins/token-ledger/` (or the same path under `PASEO_HOME`). It keeps the last 2,000 turns. Each record holds timestamps, agent ID, provider, model, token counts, cost, status, duration, and quality. Prompts, responses, tool arguments, file paths, and credentials are not recorded. A `pricing.json` file in the same folder holds your own prices per million tokens. History does not sync between hosts.

Known limits:

- Paseo does not report cache write tokens, so Claude cache writes are missing from the token columns. The reported cost stays correct, and the difference shows as a residual under the cost.
- Paseo does not report the usage of subagents that run inside a provider, so totals can be lower than the provider bill.
- Usage during a time when the plugin or daemon is offline cannot be recovered. Affected turns are marked as a gap or as unknown.
- Estimated costs use reference prices and can differ from your actual contract.
