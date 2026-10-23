# Paseo compatibility

TokenLedger's manifest allows **Paseo >=0.11.0**, on both the daemon and the app.
This policy applies from TokenLedger v0.7.0. v0.6.3 allows `>=0.9.1` and remains
the release for Paseo 0.9.1-0.10.x hosts.

## Policy

- **Minimum version:** 0.11.0, because the overview is an `addScreen` screen with
  URL params and the sidebar entry is an `addSidebarFooterItem` row with
  `SidebarRow`. Paseo 0.10 and earlier do not have these APIs, and they cannot
  be tested on a 0.11 machine. Raise the minimum only when a required API cannot
  reasonably be supported on the previous baseline.
- **No speculative upper limit:** a new Paseo release should not automatically
  disable TokenLedger. Investigate actual API or accounting changes; restrict
  a range only when an incompatibility is confirmed and cannot be adapted.
- **Verified versions are separate:** accepting a version permits loading; it
  does not certify untested future behavior. Paseo is still pre-1.0, so a minor
  release can introduce breaking changes even without a major version bump.
- **Pinned build baseline:** keep `@getpaseo/plugin`, `@getpaseo/client`, and
  `@getpaseo/protocol` pinned together at 0.11.1 as development dependencies.
  Shipped code does not import `@getpaseo/client` or `@getpaseo/protocol`: it
  derives those types from the host SDK (`client/paseo-types.ts`,
  `server/paseo-types.ts`, and structural types in `shared/`). Paseo resolves
  type-only imports when it compiles a plugin, but supplies only its SDK
  specifiers, zod, React, React Native, TanStack Query, and Node types. Git
  installs do not run `npm install`, and npm installs omit devDependencies, so
  any other type import breaks installation. Updating the host does not require
  updating these pins in lockstep.
- **Ongoing checks:** CI runs the typecheck and existing tests against 0.11.0,
  0.11.1, 0.12.0, and npm `latest`, on pushes, PRs, manual runs, and weekly. These checks
  detect type and SDK regressions; real provider turns remain necessary to
  verify token/cost semantics and host behavior. CI failures do not silently
  rewrite the compatibility range or disable installed plugins.

Do not remove `requirements.paseo`: Paseo 0.10.2 treats an omitted declaration
as a legacy `<0.8.0` plugin. Use the explicit lower bound. The host also checks
prereleases against their stable version core, so the range alone does not
exclude beta builds.

## Verification record

| Paseo | Evidence | Result |
| --- | --- | --- |
| 0.9.1 | Original host validation on 2026-09-23; baseline typecheck and 65 tests rerun on 2026-09-30 | Minimum for v0.6.x; see [v0.6.0 verification](releases/v0.6.0.md) |
| 0.10.2 | Installed desktop/daemon, published SDK, typecheck, 65 tests, plugin reload, real Claude/Codex turns on 2026-09-30 | Compatible with v0.6.3 |
| 0.11.0 | Published SDK (plugin dist identical to 0.11.1), typecheck and 65 tests on 2026-10-09 | Minimum for v0.7.0; no installed host tested |
| 0.11.1 | Installed desktop/daemon, published SDK, typecheck, 65 tests, dependency-free compile probe, plugin reload, real Claude/Codex turns, manual sidebar and overview check on 2026-10-09 | Supported by v0.7.0 |
| 0.12.0 | Installed desktop/daemon, published SDK, typecheck and 75 tests against both the 0.11.1 pin and 0.12.0, plugin reload, real Claude turns in a background workspace (before/after control) on 2026-10-23 | Requires the background-workspace fix below; otherwise compatible |
| 0.11.2 | Unreleased accounting fixes: pinned-SDK typecheck, 66 tests, installed-plugin reload, replay of existing Claude/OMP records, real host Web UI overview/pill/panel and live OMP snapshots on 2026-10-14 | Harness scopes and incomplete coverage verified; missing upstream data remains unavailable |

The 0.11.1 investigation found:

- v0.6.3 still loads from a local directory, but a `github:` or `git:` install
  fails at compile time with `Could not resolve type dependency
  "@getpaseo/client"`. v0.7.0 derives those types from the host SDK. A copy of
  the plugin without `node_modules`, installed as a directory, then compiled
  both bundles and reached "Plugin ready".
- A bare `owner/name` source now selects the official plugin registry
  (`https://plugins.paseo.sh`), and registry installs reject `--ref`. Git
  installs need the `github:` prefix.
- `addSurface`, `addSidebarItem`, and `openSurface` still work but are
  deprecated in favor of `addScreen`, `addSidebarHeaderItem` /
  `addSidebarFooterItem`, and `openScreen`. The screen id `ledger-overview` is
  unchanged.
- `PaseoApi`, `AgentUsage`, the `lastUsage` / `activeTurn` snapshots, and the
  timeline subscription contract are unchanged for the APIs used here.
- One Claude turn and one Codex turn with a shell call each produced one
  completed record. The Codex record kept two request observations.
- The installed provider source still omits cache-write counts and Codex
  provider-internal child usage. This upgrade does not resolve the existing
  [usage API gaps](paseo-usage-api.md). TokenLedger does not register a
  `registerUsageSource` provider: that API reports subscription quota windows,
  not per-turn token usage.

This review checked client types, bundle compilation, and the desktop sidebar
row and overview ranges by hand; mobile UI was not checked. It does not certify
other providers or future Paseo releases. Test agents were archived after
verification.

The 0.11.2 accounting review found two plugin errors: model-based input
normalization subtracted OMP cache twice, and session/branch snapshots were
added as turn counts. Historical snapshots are now excluded from turn totals,
while retaining their raw facts and showing late updates separately. Cache
hit rates require a complete denominator; costs disclose unknown/partial
coverage. Existing local prices and JSONL files were not rewritten.

The UI check used the installed app-dist against the running daemon in an
isolated Chromium, including the narrow ledger panel. Local-network browser
policy was disabled only for that disposable verification process; document
assets were served locally at the daemon origin without changing its CORS or
auth configuration. No mobile device or new paid model probe was used.

A copy without `node_modules` also compiled and reached "Plugin ready" on
0.11.2 under a disposable plugin ID. Its contributions returned cleanup
functions without registering tracking/UI; the probe was then removed.

The local-trial follow-up retained 66 passing tests and added upgrade cases
for dotted/hyphenated Claude custom prices, unsafe legacy-match warnings,
reported-cost preservation and warning removal after a corrected alias.
The actual Timeline renderer was also exercised with legacy and scoped data:
legacy cards no longer assert exclusion. Native Text/View were represented
as leaf components for that render-branch smoke, not a full Timeline UI run.
An isolated 0.11.2 daemon with synthetic data verified the overview warning,
the `Session ≈4.12M tok` pill and its snapshot panel, and supplied the refreshed
screenshots. No model prompt was sent. The production plugin was reloaded
for local trial only; no package version was published.

The 0.12.0 review compared the v0.11.2 and v0.12.0 sources:

- Paseo 0.12 adds background workspaces. `agents.list`, `workspaces.list`
  and their `agent_update` / `workspace_update` streams exclude them unless the
  request sets `filter.includeBackground`, and an agent that is hidden by the
  filter arrives as `remove`. TokenLedger previously retired such agents: one
  real turn in a background workspace was recorded as a 3 ms `canceled` turn
  with no usage. TokenLedger now requests background workspaces, confirms each
  `remove` with `agents.ref(id).refresh()`, and keeps the open turn when the
  agent still exists. The same turn sequence then recorded `completed` turns.
- A 0.12+ client SDK rejects `includeBackground` with "Update the host to use
  background workspaces." when the host does not advertise the feature (a 0.12
  app on a 0.11 daemon). TokenLedger retries those lists without the filter, so
  the minimum remains 0.11.0. Older daemons drop the unknown filter field.
- The plugin SDK client API, lifecycle hooks, timeline subscription and
  `AgentUsage` are unchanged. Claude still omits cache creation and reports a
  session-cumulative `totalCostUsd`; Codex still reports per-request `last`
  usage with cached input included; OMP still emits `turn_completed` before
  the final usage drain. The proxy context-meter fixes change only
  `contextWindowUsedTokens`.
- The compiler now resolves type-only `@getpaseo/protocol/*` subpath imports.
  TokenLedger does not rely on this while it supports 0.11.0.
- Agent-to-agent messages now steer a running turn instead of interrupting it,
  so one record can cover several prompts. Plugin ACP providers without
  `prompt.steer` still replace the turn.
- 0.13.0-beta.1 deprecates `/client/react-native` in favor of `/client/ui`
  (alias kept until 2027-04-20), empties the deprecated `timeline` field of the
  `turn_ended` hook (TokenLedger does not read it), and applies the background
  filter to stored agents as well.
