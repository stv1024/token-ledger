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
  0.11.1, and npm `latest`, on pushes, PRs, manual runs, and weekly. These checks
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
