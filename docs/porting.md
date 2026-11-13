# Porting from OpenUsage

WinUsage is a port of [OpenUsage](https://github.com/robinebers/openusage) (Swift, macOS) to
TypeScript on Electron. `src/core` mirrors the Swift library file by file, so a change upstream can be
found and carried over. This page is the set of rules that keeps the mirror consistent.

Ported from upstream commit `618f018` (2026-11-10).

## Layout

| Upstream (`Sources/OpenUsage/…`) | Here | Runs in |
|---|---|---|
| `Models/` | `src/core/models/` | app and panel |
| `Support/` (non-UI) | `src/core/support/` | app and panel |
| `Providers/<Name>/` | `src/core/providers/<name>/` (folder lowercased) | app only |
| `Services/` | `src/core/services/` | app only |
| `Stores/` | `src/core/stores/` | app and panel |
| `Development/` | `src/core/development/` | app only |
| `App/`, AppKit glue | `src/main/` | app (Electron main) |
| `Views/` | `src/renderer/` | panel (React) |
| `Sources/OpenUsageCLI/` | `src/cli/` | command line |
| `Tests/OpenUsageTests/<Name>Tests.swift` | `tests/<Name>.test.ts` (vitest) | |

A file keeps its Swift name: `Providers/Codex/CodexUsageMapper.swift` is
`src/core/providers/codex/CodexUsageMapper.ts`, and
`AccountProviderRuntime+ClaudeResets.swift` is `AccountProviderRuntime+ClaudeResets.ts`.

`models`, `support`, and `stores` are imported by the panel, which has no Node. They must not import
`node:` modules or Electron. `providers`, `services`, and `development` may use `node:crypto`,
`node:http`, and the rest of Node. Nothing in `src/core` imports Electron.

## Types

| Swift | TypeScript |
|---|---|
| `Date` | `Instant` = epoch **milliseconds** (`support/time.ts`) |
| `TimeInterval` | `Seconds` = seconds. Use `secondsBetween(later, earlier)` and `addSeconds(t, s)`; never mix units |
| `…Ms` values | milliseconds, name kept |
| `URL` | `string` |
| `UUID` | lowercase string (`newUUID()`) |
| `Data` | `Uint8Array` (`bodyText`, `utf8` in `support/ProviderParse.ts`) |
| `[String: Any]` | `JSONObject`; read with `asObject`, `asArray`, `asString`, `ProviderParse.number/bool` |
| `nil` | `undefined`, never `null`. Optional fields are `field?: T` and are left out when absent |
| `Calendar` | `Calendar` (`support/Calendar.ts`): `Calendar.current`, `Calendar.utc` |
| `UserDefaults` | `Defaults` (`support/Defaults.ts`): `standardDefaults()`, `MemoryDefaults` in tests |
| `@Observable` class | extends `Observable`, calls `this.notify()` after a change |
| `now: () -> Date` | `now: Clock` (`() => Instant`), default `Date.now` |
| `async throws` | `async`, throwing `Error`s |
| `Result<T, E>` | `{ ok: true, … } \| { ok: false, … }` |
| `x.rounded()` | `rounded(x)` (`support/numbers.ts`): ties away from zero, unlike `Math.round` |

### Enums

- A plain enum is a string union of its **raw values**, plus a same-named object for its statics:
  `type ResetDisplayMode = 'relative' | 'absolute'` and `ResetDisplayMode.label(mode)`.
- An enum with associated values is a discriminated union on `type`, the case name:
  `{ type: 'progress', label, used, limit, … }`. A same-named object holds factories
  (`MetricLine.percent(…)`).
- An `Error` enum is a class with a `case` field: `ProviderError.rateLimited(30)`,
  `ProviderError.is(error, 'rateLimited')`.
- `URLError` (the request never reached the server) is `NetworkError` (`models/ProviderSnapshot.ts`).

### Structs, classes, and functions

- A struct that is only data is an interface, with a same-named object for its statics and computed
  values (`Provider.fullName(provider)`). A struct with behaviour the code leans on (`WidgetData`,
  `WidgetDescriptor`) is a class.
- Function and constructor parameters keep the Swift order, with the labels dropped:
  `CodexUsageMapper.mapUsageResponse(response, resetCredits, now)`,
  `new CodexUsageClient(http)`. A parameter with a default stays optional and last.
- A nested type `Outer.Inner` is exported as `OuterInner`.
- A method added to `AccountProviderRuntime` in an extension is an exported function whose first
  parameter is the runtime: `func refreshClaude(_:)` becomes `refreshClaude(rt, credential)`.
- An enum used as a namespace (`enum CodexUsageMapper { static func … }`) is an exported object of
  the same name.
- Types that already exist here are used as they are. Read the file before calling it.

## The runtime contract

`providers/AccountProviderRuntime.ts` imports one usage read per provider, by these names:

| File | Exports |
|---|---|
| `claude/AccountProviderRuntime+ClaudeUsage.ts` | `ClaudeAccountState` (`new ClaudeAccountState(sessions)`, with `session` and `forcedReadsPending`), `refreshClaude`, `restoreClaude(rt, snapshot)`, `refreshClaudeHourlyReads(rt, snapshot)` |
| `claude/AccountProviderRuntime+ClaudeResets.ts` | `claudeResetClaimService(rt, refreshAccount)` |
| `claude/ClaudeSession.ts` | `ClaudeSessions` |
| `codex/AccountProviderRuntime+CodexUsage.ts` | `refreshCodex` |
| `codex/AccountProviderRuntime+CodexResets.ts` | `codexResetClaimService(rt, refreshAccount)` |
| `cursor/AccountProviderRuntime+CursorUsage.ts` | `refreshCursor` |
| `cursor/CursorUsageMapper.ts` | `CursorUsageMapper` (with `billingPeriodMs`) |
| `antigravity/AccountProviderRuntime+AntigravityUsage.ts` | `refreshAntigravity` |
| `antigravity/AntigravityMetric.ts` | `AntigravityMetric` |
| `copilot/AccountProviderRuntime+CopilotUsage.ts` | `refreshCopilot` |
| `devin/AccountProviderRuntime+DevinUsage.ts` | `refreshDevin` |
| `grok/AccountProviderRuntime+GrokUsage.ts` | `refreshGrok` |
| `muse/AccountProviderRuntime+MuseUsage.ts` | `refreshMuse` |
| `ollama/AccountProviderRuntime+OllamaUsage.ts` | `refreshOllama` |
| `opencode/AccountProviderRuntime+OpenCodeUsage.ts` | `refreshOpenCode` |
| `openrouter/AccountProviderRuntime+OpenRouterUsage.ts` | `refreshOpenRouter` |
| `zai/AccountProviderRuntime+ZAIUsage.ts` | `refreshZAI` |
| `zai/AccountProviderRuntime+ZAIResets.ts` | `zaiResetClaimService(rt, refreshAccount)` |
| `zai/ZAIResets.ts` | `ZAIReset` |

Every `refresh<Name>` has the signature
`(rt: AccountProviderRuntime, credential: AccountCredential) => Promise<ProviderUsage>`. Upstream keeps
several of these bodies inside `AccountProviderRuntime.swift`; here each lives in its provider's
folder. The `*ResetClaimService` functions build the `ResetClaimService` that upstream's
`resetClaimService(refreshAccount:)` switch builds for that kind.

The runtime gives a read what it needs: `rt.http`, `rt.now()`, `rt.account`, `rt.cardID`,
`rt.freshTokens`, `rt.authorizedRead`, `rt.renewedTokens`, `rt.successBody`, the `SecondaryRead`
fields, the ledgers, and `refreshHistory(rt, source, ledger?)` from `providers/UsageLedger.ts`.

Sign-ins export their token renewal as `XLogin.refresh`, a `TokenGrant`:
`(refreshToken, http, now) => Promise<OAuthGrant>`.

## What differs from upstream on purpose

- **Name and logo.** OpenUsage's name and logo are trademarks and are not used. User-facing text says
  `AppInfo.name`, never a literal. "this Mac" reads "this computer" or "this PC".
- **Telemetry.** There is none: no PostHog, no daily ping, no crash upload.
- **Credentials.** The macOS Keychain becomes files encrypted with Windows DPAPI (Electron
  `safeStorage`) in the app's data folder.
- **Menu bar.** Windows has no text strip in the tray. The tray icon carries the most urgent limit,
  and its tooltip lists what the strip would.
- **Shortcuts.** ⌘ becomes Ctrl.
- **0.7.x migration** (`APIKeyV1Files`, `LayoutV1Keys`) is not ported: there is no Windows 0.7.x of
  this port to upgrade from.

## Tests

Port a Swift test file to `tests/<Name>.test.ts` with the same cases and names. Tests that exercise
AppKit, SwiftUI layout, or the Keychain have no port. Run `npm test` and `npm run typecheck`.
