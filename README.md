# WinUsage

Track your AI coding subscriptions from the Windows system tray.

WinUsage shows how much of each AI plan you've used: session and weekly limits, credits, and
balances, all in one panel that opens from the tray. The tray icon carries the limit closest to
running out, and its tooltip lists the rest.

> WinUsage is an **unofficial Windows port** of [OpenUsage](https://github.com/robinebers/openusage)
> by Robin Ebers. It is not affiliated with or endorsed by the OpenUsage project. "OpenUsage" and its
> logo are trademarks of Robin Ebers and are not used here; see upstream's
> [trademark policy](https://github.com/robinebers/openusage/blob/main/TRADEMARK.md).

**Status: early.** The app has not yet been released or tested on Windows.

## Supported providers

The same as upstream: Claude, ChatGPT (Codex), Cursor, Antigravity, Copilot, Devin, Grok, Muse Code,
Ollama, OpenCode, OpenRouter, Z.ai, and [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)
hubs. Add accounts from the panel's Accounts screen. WinUsage never reads other tools' credentials,
files, or logs.

## Features

- **Tray icon.** The most urgent limit as a coloured badge; hover for the full list.
- **Priority.** What's running low, what's used up, and which accounts need you.
- **All Usage.** Every account and limit, with resets, your pace, and an even-pace mark.
- **Your layout.** Pin, hide, and drag metrics into your own order.
- **Rate-limit resets.** See and spend Claude and ChatGPT resets.
- **Share.** Copy a picture of your usage to the clipboard.
- **Notifications** before a limit runs out, or before a weekly limit resets mostly unused.
- **Command line.** `winusage` prints what the app last fetched as JSON (Settings → Command Line puts it
  on your PATH).
- **Privacy Mode.** Keeps the panel out of screenshots and screen shares, and the tray shows only the
  app icon.

## How it differs from OpenUsage

- **Tray, not menu bar.** Windows has no text strip in the tray, so the icon shows one value and the
  tooltip shows the rest (up to Windows' 127-character limit).
- **Credentials** are stored in files encrypted with Windows DPAPI (Electron `safeStorage`) under
  `%APPDATA%\WinUsage`, instead of the macOS Keychain.
- **Privacy Mode** cannot detect screen sharing on Windows. While it is on, the panel is always
  excluded from capture and the tray hides figures.
- **No telemetry.** No analytics, daily ping, or crash upload.
- **Shortcuts** use Ctrl where macOS uses ⌘.
- No migration from OpenUsage 0.7.x.

The full list of porting rules is in [docs/porting.md](docs/porting.md).

## Building

Requires Node.js 22.

```sh
npm install
npm test            # unit tests
npm run typecheck
npm run dev         # run the app from source
npm run dev:demo    # run it on sample data, with no accounts
npm run dist:win    # Windows x64 installer in dist/
```

`dist:win` runs on macOS, Apple Silicon included (see `toolsets` in `electron-builder.yml`). If code-signing tools need Wine there, set
`win.signAndEditExecutable: false` in `electron-builder.yml`, or build on Windows. CI builds the
installer on `windows-latest` (`.github/workflows/build.yml`).

To check the screens without Windows, `npx electron-vite build && npx electron .
--demo=4242 --capture=<folder>` saves a picture of each screen, in light and dark, to `<folder>`.

## Project layout

| Folder | What |
|---|---|
| `src/core` | Models, providers, sign-ins, and stores: a file-by-file port of upstream's Swift library |
| `src/main` | Electron main process: tray, panel window, settings, updater, notifications |
| `src/renderer` | The panel (React) |
| `src/cli` | The `winusage` command |
| `tests` | Vitest ports of upstream's tests |

## License

MIT, as upstream. See [LICENSE](LICENSE).
