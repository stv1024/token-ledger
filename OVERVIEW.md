TokenLedger records the tokens and cost of each agent turn and keeps the history on the daemon host. It shows usage in four places: a ledger panel for each agent, a cost and context pill beside the message box, a sidebar footer row with today's cost, and an overview screen for all sessions.

The agent panel shows session totals, the turn in progress with its context window, and one row per finished turn with status, time, duration, input, cache and output tokens, cost, and a data quality mark. The pill shows the session cost and context use, with an activity icon while a turn runs, and opens the panel. The sidebar row opens the overview, which groups agents by workspace and filters to today, the last 7 days, the last 30 days, or all time. Day ranges start at local midnight on the device that shows them. After each finished turn, the plugin can add one short usage summary to the timeline.

Token counts come from the provider. Claude terminal aggregates and observed Codex requests contribute to turn subtotals. OMP current-session/branch totals and unverified-harness observations remain visible as snapshots but are excluded from turn sums and prices. A separate latest-snapshot card retains late updates without inventing turn attribution. Missing counts/rates display as unknown; cache hit rates require a complete prompt denominator. Partial estimates and unknown-cost turns are explicit in the panel, pill and overview. Runtime-reported costs take priority over your reference prices, OpenRouter references and built-in prices, but are not verified bills.

The pill distinguishes known session snapshots (`Session ≈4.12M tok`), unknown-scope snapshots, waiting for usage and no reported usage. Old timeline cards without scope metadata are labelled as legacy; their ledger inclusion is not guessed from the card.

The plugin settings page on each host has five options:

- **Timeline summaries** turns the usage summary after each new turn on or off. Existing summaries stay.
- **OpenRouter reference prices** lets the plugin download the public model price list from `openrouter.ai` in the background and cache it for 24 hours. The request carries no tokens, prompts, or usage data. Turn it off to stop the download and stop using those prices.
- **Built-in fallback prices** controls estimates when no custom or OpenRouter price matches a model.
- **Prefer price estimates** uses a matching custom or reference price instead of the cost the runtime reports. Use it for local or unbilled models. It is off by default.
- **Refresh frequency** selects normal or relaxed polling. Live updates still refresh the views immediately.

The ledger is a JSON Lines file on the daemon host, `~/.paseo/plugins/token-ledger/` (or under `PASEO_HOME`), retaining 2,000 records. It stores observed usage, timestamps, identity, scope and quality, not prompts, responses, tool arguments or credentials. Older records remain readable and are reinterpreted without rewriting them. `pricing.json` starts empty and preserves your existing prices. Full model IDs and explicit aliases prevent unrelated routes from sharing a guessed price. History does not sync between hosts.

Standard Claude numeric-version spellings such as `5.5` and `5-5` retain custom-price compatibility. Other old lossy matches or ambiguous entries show a pricing configuration warning and block reference-price fallback until an explicit alias/provider scope is reviewed. Existing files are not rewritten, and valid edits clear the warning automatically.

Known limits:

- Missing cache writes are not zero; setting prices cannot recover omitted token counts. A reported-cost residual does not prove a cache-write charge.
- Child coverage differs by harness. Codex child usage can be omitted; OMP already includes some child usage. Blindly adding children can double-count.
- Session snapshots cannot safely become per-turn deltas without branch epochs and final usage attribution; they are not included in date-range totals.
- Offline observations and missing request identities cannot be reconstructed. Affected usage stays incomplete or unknown.
- Runtime and reference prices can differ from actual contracts. No private gateway rate table or fixed exchange rate is built in.
