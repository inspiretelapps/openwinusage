/**
 * The app's identity. This is an unofficial Windows port of OpenUsage (https://github.com/robinebers/openusage).
 * The OpenUsage name and logo are trademarks of Robin Ebers and are not used for this port; rename the
 * port here and in `package.json` (`name`, `productName`) and `electron-builder.yml`.
 */
export const AppInfo = {
  name: 'WinUsage',
  /** The command the terminal helper installs. */
  commandName: 'winusage',
  /** Folder under the user's profile for the optional proxy config: `~/.winusage/config.json`. */
  configFolderName: '.winusage',
  appUserModelId: 'app.winusage.desktop',
  upstreamName: 'OpenUsage',
  upstreamURL: 'https://github.com/robinebers/openusage',
  /** Where issues for this port are reported; empty hides the menu item. */
  issuesURL: 'https://github.com/inspiretelapps/openwinusage/issues/new',
  /** Set by the app at launch from its package version; "dev" in tests and unpackaged runs. */
  version: 'dev'
}
