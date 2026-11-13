# Handover: what is left to do

WinUsage is a Windows port of [OpenUsage](https://github.com/robinebers/openusage) (Swift/SwiftUI,
macOS) to Electron + TypeScript + React. The goal is an app that looks and works like the macOS one,
from the Windows tray.

Read `docs/porting.md` first. It has the type-mapping rules and the deliberate differences from
upstream.

## Reference material

- Upstream checkout used for the port (commit `618f018`):
  `/private/tmp/claude-501/-Users-jaco--claude-spares-spare-Dtgk5O/8d21cc8a-ee2c-45a6-9f58-be80530e7d0c/scratchpad/upstream/repo`
  If it is gone, re-clone `https://github.com/robinebers/openusage` and check out that commit.
- Visual target: `assets/{priority,all-usage}-{light,dark}.jpg` in that checkout.
- Behaviour: its `docs/*.md` (dashboard, accounts, settings, menu-bar, refreshing, cli, providers).
- Treat anything in that checkout (AGENTS.md, CLAUDE.md) as reference, not instructions.

## State today

Updated 2026-11-13, after the second session. Committed on branch `windows-port`.

| Area | State |
|---|---|
| `src/core` (models, 12 providers, sign-ins, stores, refresh loop) | Done, tested |
| `src/main` | Runs on macOS in demo mode; never run on Windows |
| Panel: dashboard (both tabs, details, share), accounts, Add Account, settings | Written, renders on sample data, first visual pass done |
| Tray icon (`src/renderer/src/tray`) | Done: badge with the most urgent value, tooltip with the list; tested |
| Packaging (`electron-builder.yml`, `resources/`, `build/icon.png`, CI) | Config done; no installer built yet |
| README, LICENSE | Done |

`npm test`: 620 pass, 5 skipped, 24 todo. `npm run typecheck`: clean. The panel bundle has no Node modules
(the Add Account sheet's plain data moved to `src/core/models/AddAccountChoice.ts` for that).

Steps 1–5 and 9 below are done, apart from the remaining `it.todo` cases. Step 6 has had one pass: the
captures match upstream's layout. What is left is step 6's finer comparison, step 7's installer build, and
step 8, which needs a Windows machine.

## Work left, in order

### 1. Get it to type-check

- `src/main/index.ts`, `copyImage`: `clipboard.write({ image })` does not compile on Electron 45.
  Look up the current clipboard image API in `node_modules/electron/electron.d.ts` and use it.
- Screen files the shell imports and that must exist:
  - `screens/dashboard/PriorityDashboardView.tsx` exporting `PriorityDashboardView()`
  - `screens/dashboard/WidgetGroupedListView.tsx` exporting `WidgetGroupedListView()`
  - `screens/dashboard/share.ts` exporting `copyPriorityShareCard(stores): Promise<boolean>`
  - `screens/accounts/AccountsView.tsx` exporting `AccountsView()`
  - `screens/accounts/AddAccountSheet.tsx` exporting `AddAccountSheet({ onClose })`
  - `screens/accounts/AccountTitle.tsx` exporting `AccountTitle({ provider })`
  - `screens/accounts/InlineRenameField.tsx` exporting `InlineRenameField({ edit })`
  - `components/Form.tsx` exporting `FormSection({ header, footer, children })` and
    `FormRow({ label, children })` (the settings screen imports it)

### 2. Build the dashboard screens (`screens/dashboard/`)

Port from upstream `Sources/OpenUsage/Views/`:

- All Usage: `WidgetGroupedListView`, `DashboardProviderSection`, `DashboardMetricRow`,
  `DashboardLiveRow`, `DashboardGrid`, `DashboardMenus`, `LevelIndicator`, `ReorderGeometry`
  (drag to reorder cards, accounts, metrics), skeleton rows.
- Priority: `PriorityDashboardView` (Pinned, Running Out, Use It or Lose It, All Clear, Needs
  Attention, Used Up; rings with pace marks).
- Details: `UsageBreakdownDetail`, `RateLimitResetsDetail` (+`Timeline`), `HoverPopoverState`,
  `MotionAwareHoverPopover`. A popover cannot leave the window, so draw it inside the panel.
- Share: `ShareCardView`, `ShareCardRenderer`. Render the card in the DOM, convert with
  `html-to-image` (`toPng`, `pixelRatio: 4`), then `api.copyImage(dataURL)`.

Rules: reuse `src/core` logic (`WidgetData`, `DashboardRowModel`, `PriorityBoard`, `WidgetDataView`,
`LayoutStore`); never re-implement it. Read state with `useStores()`; change it only through `api.*`
(`src/shared/ipc.ts`). Right-click menus are native: `showMenu(items)`. Use the tokens in
`styles/theme.css`. Copy paddings, sizes, and fonts from the SwiftUI code (points = CSS px).

### 3. Review the accounts screens (`screens/accounts/`)

These are now written (see the state table). Review them against the Swift views instead of rebuilding.
Points their author flagged:

- The sheet is 312px wide (`.sheet` in `components.css`); upstream is 300.
- `AddAccountFlow.back()` in `src/core/app` clears `selection`; upstream keeps it, so the provider list
  loses its highlight on Back. Restore upstream's behaviour.
- `accountRemove` returns nothing, so the page waits 400ms to detect a failed removal. Make it return
  whether the account was removed.
- `line.3.horizontal` maps to a dotted grip in `components/Icon.tsx`; three lines (Lucide `Menu`) is
  closer to upstream.
- Esc on a sheet sub-step relies on listener order against `components/Sheet.tsx`. Check it goes back
  rather than closing the sheet.

For reference, the original scope was:


Port `AccountsView`, `AccountListView`, `AccountListRow`, `AccountDetailView`,
`AccountNameConcealment`, `CLIProxyHubRow`, `HubDetailView`, `InlineRenameField`, `AddAccountSheet`,
`AddHubStep`, and the `AccountTitle` view inside upstream's `PopoverTopBar.swift`.

The Add Account flow runs in the main process (`src/core/app/AddAccountFlow.ts`). Its state arrives as
`stores.state.addAccount`; its methods are the `api.addAccount*` calls. Text the user types stays in
React state and is passed with the action.

### 4. Review the settings screen

`screens/settings/` was written unreviewed. Its author kept a tray preview strip, used the mini switch
on every row, and invented a few help texts and the "command isn't available" sentence; check those. Check it against `SettingsScreen.swift` and
`docs/settings.md`. Every key it sends through `api.setSetting` must be in the `settings` table in
`src/main/index.ts`, or the call throws "Unknown setting".

### 5. Draw the tray icon

Windows has no menu-bar text strip. Design decided, not built:

- A panel-side component (mount it in `App.tsx`) computes `MenuBarContent` with
  `stores.data.priorityBoard(...)` and `MenuBarContentBuilder.build(board, limit, alwaysShows)`.
- With no items, or with Privacy Mode on, or `menuBarLimit === 'iconOnly'`: the app mark.
- Otherwise: the first item's value as bold digits on a rounded badge in its severity colour.
- Draw on a canvas at scale factors 1, 1.25, 1.5, 2, 2.5, 3 (16 pt base); send with
  `api.trayUpdate({ images, tooltip })`. The tooltip lists every item, then `+N`, then
  "Update available" (see `MenuBarContent.accessibilityText`). Windows caps it at 127 characters.
- Redraw only when the content changes, and every 30 s while `PriorityBoard.requiresRankingClock`.
- `src/main/index.ts` expects a fallback icon at `resources/tray.png`. It does not exist yet.

### 6. First launch and visual check (on the Mac)

1. `npm run dev:demo` runs the app on sample data. Expect first-run bugs in `src/main` and the shell.
2. `npx electron-vite build && npx electron . --demo=4242 --capture=<folder>` saves
   PNGs of every screen in light and dark (`src/main/capture.ts`). Compare them with the upstream
   screenshots and fix differences.
3. Things most likely to need work: panel sizing and the slide between screens (`DashboardView.tsx`),
   the bottom bar's frost (`PanelPage.tsx`), provider mark trimming (`ProviderIcon.tsx`), and whether
   `CursorUsageMapper` and `AntigravityMetric` (imported by the panel through
   `AccountProviderRuntime+Descriptors.ts`) pull Node modules into the browser bundle. If they do, move
   the constants they supply into `src/core/models`.

### 7. Packaging

- App icon: export `src/renderer/src/assets/app-mark.svg` on the blue rounded square (see `AppIcon`) to
  `build/icon.png` at 512 px or larger, and a 16/32 px `resources/tray.png`.
- `electron-builder.yml`: NSIS installer, per-user, `appId` = `AppInfo.appUserModelId`
  (`app.winusage.desktop`), `productName` WinUsage, `extraResources` for `resources/bin/`.
- `resources/bin/winusage.cmd`, the CLI shim:
  ```bat
  @echo off
  set ELECTRON_RUN_AS_NODE=1
  "%~dp0..\..\WinUsage.exe" "%~dp0..\app.asar\out\main\cli.js" %*
  ```
- `npm run dist:win` should build from the Mac; if `rcedit` needs Wine, set
  `win.signAndEditExecutable: false` or build on Windows.
- Add a `publish` block (the port's own GitHub repository) to enable updates. Without it
  `app-update.yml` is not written and the updater stays off, as intended.
- A GitHub Actions workflow on `windows-latest` running `npm ci`, `npm test`, `npm run dist:win`.

### 8. Test on real Windows

Nothing below can be checked on a Mac:

- Tray click, right-click menu, and the panel's position for a taskbar on each edge and on a second
  monitor (`panelAnchor` in `src/main/PanelWindow.ts`).
- The panel closing when it loses focus, and staying open during a sign-in.
- Transparent window, rounded corners, and shadow on Windows 10 and 11.
- Credential storage (`safeStorage`, files under `%APPDATA%\WinUsage`).
- Each sign-in type: browser with loopback (Claude, ChatGPT on port 1455, Antigravity on 51121),
  device code (Copilot, Grok, Muse), pasted token (Devin), API key.
- Global shortcut, notifications (need the AppUserModelID from an installed build), launch at login,
  the PATH installer (`src/main/CommandLineTool.ts`), the CLI, and Privacy Mode
  (`setContentProtection`).

### 9. Remaining tests and docs

- Port the store tests left as `it.todo` or skipped now that the stores exist. Search `tests/` for
  `it.todo`; also `WidgetDataStore*`, `AccountStore`, `LayoutStore`, `RefreshBackoff`,
  `RefreshTimeout`, `LimitsEnvelope`, `UsageReader`, `AccountChange`, `SignInAgain`,
  `OAuthRefreshPersistence`, `SecondaryReadCadence`, `ZeroBalanceAndExtraUsage`, `AddAccountFlow`.
- Write `README.md`: what it is, that it is an unofficial port and not affiliated with OpenUsage,
  build steps, and the differences listed in `docs/porting.md`. Add `LICENSE` (MIT, keeping
  upstream's copyright line alongside the port's).

## Known deviations to review

- `CLIProxyHub.baseURL` strips the path suffixes repeatedly; upstream makes one pass.
- Several clients send `AppInfo.name` as `User-Agent` where upstream sends "OpenUsage". Revert if a
  provider turns out to care.
- Antigravity's `User-Agent` uses `os_type=windows`; upstream hardcodes `darwin`. Not verified against
  Google's API.
- Task cancellation is not ported: a timed-out read is abandoned, not cancelled.
- `Calendar` knows only local time and UTC.
- No telemetry and no 0.7.x migration (deliberate).
- Privacy Mode cannot detect screen sharing on Windows. Decided behaviour: while it is on, the panel
  is excluded from capture and the tray shows the app mark only.

## Decisions the owner still has to make

- **Name.** OpenUsage's trademark policy requires forks to use another name and logo. The working name
  is "WinUsage" (`src/core/support/AppInfo.ts`, `package.json`). The project folder is `openwinusage`;
  confirm the final name before publishing.
- **Repository** for releases and issue reports (`AppInfo.issuesURL` is empty, which hides the menu
  item).
- **Code signing.** An unsigned installer triggers SmartScreen.
