import { ClipboardItem, Menu, Notification, Tray, app, clipboard, dialog, globalShortcut, ipcMain, nativeImage, nativeTheme, shell, systemPreferences, type MenuItemConstructorOptions } from 'electron'
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { AddAccountFlow } from '@core/app/AddAccountFlow'
import { AppContainer } from '@core/app/AppContainer'
import { DemoSession } from '@core/development/DemoSession'
import { DashboardTab } from '@core/models/DashboardTab'
import { ProviderLoginCatalog } from '@core/services/DeviceProviderLogins'
import { AccountStore } from '@core/stores/AccountStore'
import { AppearanceSetting } from '@core/stores/AppearanceSetting'
import { HideFromScreenShareSetting } from '@core/stores/HideFromScreenShareSetting'
import { LaunchAtLoginSetting } from '@core/stores/LaunchAtLoginSetting'
import { LogLevelSetting } from '@core/stores/LogLevelSetting'
import { TimeFormatSetting } from '@core/stores/TimeFormatSetting'
import { DisplaySettingKeys } from '@core/stores/WidgetDataStore'
import { AppInfo } from '@core/support/AppInfo'
import { AppLog, describeError, type LogLine } from '@core/support/AppLog'
import { MemoryDefaults, defaultsString, setStandardDefaults, type Defaults } from '@core/support/Defaults'
import { ModelFigure } from '@core/models/UsageHistory'
import { MenuBarLimit } from '@core/models/MenuBarLimit'
import { PriorityLimits } from '@core/models/PriorityLimits'
import { ResetDisplayMode } from '@core/models/ResetDisplayMode'
import { WidgetDisplayMode } from '@core/models/WidgetDisplayMode'
import { PaceMilestone } from '@core/support/PaceNotificationLogic'
import { IpcChannels, type Api, type ApiMethod, type AppState, type MenuItemSpec, type ResetClaimInfo } from '@shared/ipc'
import { CommandLineTool } from './CommandLineTool'
import { ElectronHTTPClient } from './ElectronHTTPClient'
import { FileDefaults } from './FileDefaults'
import { PanelWindow, rendererEntry } from './PanelWindow'
import { SafeStorageCredentialVault, SafeStorageHubKeyVault } from './SafeStorageVault'
import { UpdaterController } from './Updater'

const shortcutKey = 'globalShortcut'
const args = process.argv.slice(1)
const demoArgument = args.find((argument) => argument === '--demo' || argument.startsWith('--demo='))
const isDemo = demoArgument !== undefined
const demoSeed = demoArgument?.includes('=') ? Number(demoArgument.split('=')[1]) : undefined
/** `--capture=<folder>`: a development aid that opens the panel, saves pictures of its screens there, and quits. */
const captureFolder = args.find((argument) => argument.startsWith('--capture='))?.slice('--capture='.length)

app.setName(AppInfo.name)
if (isDemo) app.setPath('userData', join(app.getPath('temp'), `${AppInfo.name}-demo`))

function installLog(folder: string): void {
  mkdirSync(folder, { recursive: true })
  const file = join(folder, 'winusage.log')
  AppLog.sink = (line: LogLine): void => {
    try {
      try {
        if (statSync(file).size > 2_000_000) renameSync(file, `${file}.1`)
      } catch {
        // No log yet.
      }
      appendFileSync(file, `${new Date(line.at).toISOString()} ${line.level.toUpperCase().padEnd(5)} [${line.tag}] ${line.message}\n`)
    } catch {
      // Logging must never take the app down.
    }
    if (!app.isPackaged) console.log(`[${line.tag}] ${line.message}`)
  }
}

function start(): void {
  AppInfo.version = app.isPackaged ? app.getVersion() : `dev (${app.getVersion()})`
  app.setAppUserModelId(AppInfo.appUserModelId)
  installLog(app.getPath('logs'))

  const dataFolder = app.getPath('userData')
  const defaults: MemoryDefaults = isDemo ? new MemoryDefaults() : new FileDefaults(join(dataFolder, 'preferences.json'))
  setStandardDefaults(defaults)
  AppLog.level = LogLevelSetting.current
  AppLog.bootstrap()
  nativeTheme.themeSource = AppearanceSetting.current

  const updater = new UpdaterController(defaults)
  const commandLine = new CommandLineTool(process.resourcesPath)
  const launchAtLogin = new LaunchAtLoginSetting(
    () => app.getLoginItemSettings().openAtLogin,
    (enabled) => app.setLoginItemSettings({ openAtLogin: enabled })
  )

  let panel: PanelWindow | undefined
  let tray: Tray | undefined
  const openPanel = (tab: DashboardTab = DashboardTab.preferred(defaults), screenName?: 'dashboard' | 'settings'): void => {
    if (!panel || !tray) return
    panel.show(tray.getBounds(), tab, screenName)
  }

  const postNotification = async (idPrefix: string, title: string, subtitle: string, body: string): Promise<boolean> => {
    if (!Notification.isSupported()) return false
    try {
      const notification = new Notification({ title: `${title}: ${subtitle}`, body })
      notification.on('click', () => {
        AppLog.info('notifications', 'notification clicked; opening the panel')
        openPanel('allUsage')
      })
      notification.show()
      AppLog.info('notifications', `posted ${idPrefix}`)
      return true
    } catch (error) {
      AppLog.error('notifications', `post ${idPrefix} failed: ${describeError(error)}`)
      return false
    }
  }

  // Sign-ins use the real network even on sample data, as upstream's demo does.
  const http = new ElectronHTTPClient()
  ProviderLoginCatalog.http = http

  let demo: DemoSession | undefined
  let container: AppContainer
  if (isDemo) {
    const made = DemoSession.makeContainer(defaults, { seed: Number.isFinite(demoSeed) ? demoSeed : undefined, postNotification })
    container = made.container
    demo = made.session
  } else {
    const accounts = new AccountStore({ defaults, vault: new SafeStorageCredentialVault(dataFolder), hubKeys: new SafeStorageHubKeyVault(dataFolder) })
    container = new AppContainer({ accounts, defaults, http, postNotification })
  }

  let flow: AddAccountFlow | undefined
  let shortcutError: string | undefined
  let shortcutRecording = false

  const resetClaims = (): Record<string, ResetClaimInfo> => {
    const claims: Record<string, ResetClaimInfo> = {}
    for (const runtime of container.runtimes) {
      const kind = runtime.provider.kind
      if (kind !== 'claude' && kind !== 'codex' && kind !== 'zai') continue
      const service = container.resetClaim(runtime.provider.id)
      if (!service) continue
      const info: ResetClaimInfo = { isClaimable: service.isClaimable, windowResets: service.windowResets }
      if (service.confirmDetail !== undefined) info.confirmDetail = service.confirmDetail
      claims[runtime.provider.id] = info
    }
    return claims
  }

  const buildState = (): AppState => {
    const data = container.dataStore
    const state: AppState = {
      defaults: defaults.snapshot(),
      backoffs: { ...data.backoffs },
      refreshingProviderIDs: [...data.refreshingProviderIDs],
      burningFastWindows: Object.fromEntries(data.burningFastWindows),
      isRefreshingNow: container.isRefreshingNow,
      canUndo: container.layout.canUndo,
      hubStatuses: Object.fromEntries(container.accounts.hubs.map((hub) => [hub.id, container.hubs.status(hub.id)])),
      resetClaims: resetClaims(),
      privacyMode: { isEnabled: container.hideFromScreenShare.isEnabled, isConcealing: container.hideFromScreenShare.isConcealing },
      updater: updater.state,
      launchAtLogin: { isEnabled: launchAtLogin.isEnabled },
      shortcut: {},
      commandLine: commandLine.state,
      app: {
        name: AppInfo.name,
        version: AppInfo.version,
        commandName: AppInfo.commandName,
        isPackaged: app.isPackaged,
        platform: process.platform,
        issuesURL: AppInfo.issuesURL,
        upstreamName: AppInfo.upstreamName,
        upstreamURL: AppInfo.upstreamURL
      },
      systemDark: nativeTheme.shouldUseDarkColors,
      reduceMotion: process.platform === 'win32' ? !systemPreferences.getAnimationSettings().shouldRenderRichAnimation : false
    }
    if (data.lastRefreshAt !== undefined) state.lastRefreshAt = data.lastRefreshAt
    if (container.accounts.lastError !== undefined) state.accountsLastError = container.accounts.lastError
    if (launchAtLogin.errorMessage !== undefined) state.launchAtLogin.errorMessage = launchAtLogin.errorMessage
    const accelerator = defaultsString(defaults, shortcutKey)
    if (accelerator !== undefined) state.shortcut.accelerator = accelerator
    if (shortcutError !== undefined) state.shortcut.errorMessage = shortcutError
    if (flow) state.addAccount = flow.state
    if (demo) state.demo = { seed: demo.seed }
    return state
  }

  let pushScheduled = false
  const pushState = (): void => {
    if (pushScheduled) return
    pushScheduled = true
    setImmediate(() => {
      pushScheduled = false
      if (panel && !panel.window.isDestroyed()) panel.window.webContents.send(IpcChannels.state, buildState())
    })
  }
  for (const observable of [container, container.accounts, container.layout, container.dataStore, container.hubs, container.hideFromScreenShare, updater, commandLine, launchAtLogin]) {
    observable.subscribe(pushState)
  }
  demo?.subscribe(pushState)
  nativeTheme.on('updated', pushState)

  // The global shortcut

  const registerShortcut = (): void => {
    globalShortcut.unregisterAll()
    shortcutError = undefined
    const accelerator = defaultsString(defaults, shortcutKey)
    if (accelerator === undefined || shortcutRecording) return
    try {
      const registered = globalShortcut.register(accelerator, () => {
        AppLog.info('statusitem', 'Global shortcut fired; toggling the panel')
        togglePanel()
      })
      if (!registered) shortcutError = 'That shortcut is used by Windows or another app. Choose a different one.'
    } catch {
      shortcutError = 'That shortcut can’t be used. Choose a different one.'
    }
  }

  const togglePanel = (): void => {
    if (!panel) return
    if (panel.isVisible) panel.hide()
    else if (!panel.justHid) openPanel()
  }

  // Settings the panel may write, each with the values it accepts.

  const oneOf = (allowed: readonly string[]) => (value: unknown): boolean => typeof value === 'string' && allowed.includes(value)
  const isBool = (value: unknown): boolean => typeof value === 'boolean'
  const settings: Record<string, { accepts: (value: unknown) => boolean; apply?: (value: never) => void }> = {
    [DisplaySettingKeys.meterStyle]: { accepts: oneOf(WidgetDisplayMode.allCases), apply: (value: WidgetDisplayMode) => (container.dataStore.meterStyle = value) },
    [DisplaySettingKeys.resetDisplayMode]: { accepts: oneOf(ResetDisplayMode.allCases), apply: (value: ResetDisplayMode) => (container.dataStore.resetDisplayMode = value) },
    [DisplaySettingKeys.menuBarLimit]: { accepts: oneOf(MenuBarLimit.allCases), apply: (value: MenuBarLimit) => (container.dataStore.menuBarLimit = value) },
    [DisplaySettingKeys.menuBarAlwaysShows]: { accepts: isBool, apply: (value: boolean) => (container.dataStore.menuBarAlwaysShows = value) },
    [DisplaySettingKeys.priorityWarning]: {
      accepts: (value) => typeof value === 'number',
      apply: (value: number) => (container.dataStore.priorityLimits = PriorityLimits.make(value, container.dataStore.priorityLimits.critical))
    },
    [DisplaySettingKeys.priorityCritical]: {
      accepts: (value) => typeof value === 'number',
      apply: (value: number) => (container.dataStore.priorityLimits = PriorityLimits.make(container.dataStore.priorityLimits.warning, value))
    },
    [DisplaySettingKeys.priorityBurningFast]: { accepts: isBool, apply: (value: boolean) => (container.dataStore.showsBurningFast = value) },
    [DisplaySettingKeys.priorityUseItOrLoseIt]: { accepts: isBool, apply: (value: boolean) => (container.dataStore.showsUseItOrLoseIt = value) },
    [DisplaySettingKeys.paceMarks]: { accepts: isBool, apply: (value: boolean) => (container.dataStore.showsPaceMarks = value) },
    [AppearanceSetting.key]: { accepts: oneOf(AppearanceSetting.allCases) },
    [TimeFormatSetting.key]: { accepts: oneOf(TimeFormatSetting.allCases) },
    [LogLevelSetting.key]: { accepts: oneOf(LogLevelSetting.allCases) },
    [DashboardTab.defaultKey]: { accepts: oneOf(DashboardTab.allCases) },
    [ModelFigure.key]: { accepts: oneOf(ModelFigure.allCases) }
  }
  for (const milestone of PaceMilestone.allCases) settings[PaceMilestone.settingKey(milestone)] = { accepts: isBool }

  const openFlow = (signingInAgainProviderID?: string): void => {
    flow?.cancel()
    const account = signingInAgainProviderID !== undefined ? container.accounts.account(signingInAgainProviderID) : undefined
    flow = new AddAccountFlow({
      store: container.accounts,
      openURL: (url) => void shell.openExternal(url),
      connectHub: (url, key, signal) => container.hubs.connect(url, key, signal),
      replaceCredential: (credential, providerID, signal) => container.signInAgain(credential, providerID, signal),
      signingInAgainTo: account
    })
    flow.subscribe(pushState)
    flow.startSigningInAgain()
    pushState()
  }

  const buildMenu = (items: MenuItemSpec[], choose: (id: string) => void): MenuItemConstructorOptions[] =>
    items.map((item): MenuItemConstructorOptions => {
      if (item.type === 'separator') return { type: 'separator' }
      const label = item.accelerator ? `${item.label ?? ''}\t${item.accelerator}` : (item.label ?? '')
      if (item.submenu) return { label, enabled: item.enabled ?? true, submenu: buildMenu(item.submenu, choose) }
      return {
        label,
        type: item.type === 'checkbox' ? 'checkbox' : 'normal',
        checked: item.checked,
        enabled: item.isInformational ? false : (item.enabled ?? true),
        click: () => {
          if (item.id !== undefined) choose(item.id)
        }
      }
    })

  const api: Api = {
    getState: buildState,

    layoutSetMetricShown: (id, shown) => container.layout.setMetricShown(id, shown),
    layoutSetMetricPinned: (id, pinned) => container.layout.setMetricPinned(id, pinned),
    layoutReorderProvider: (dragged, target) => container.layout.reorderProvider(dragged, target),
    layoutReorderFamily: (dragged, target) => container.layout.reorderFamily(dragged, target),
    layoutReorderMetric: (dragged, target, providerID) => container.layout.reorderMetric(dragged, target, providerID),
    layoutUndo: () => container.layout.undo(),

    setSetting: (key, value) => {
      const setting = settings[key]
      if (!setting || !setting.accepts(value)) throw new Error(`Unknown setting: ${key}`)
      if (setting.apply) (setting.apply as (value: unknown) => void)(value)
      else defaults.set(key, value)
      if (key === AppearanceSetting.key) nativeTheme.themeSource = AppearanceSetting.current
      if (key === LogLevelSetting.key) AppLog.level = LogLevelSetting.current
      pushState()
    },
    setLaunchAtLogin: (enabled) => launchAtLogin.update(enabled),
    setShortcut: (accelerator) => {
      defaults.set(shortcutKey, accelerator)
      registerShortcut()
      pushState()
    },
    setShortcutRecording: (recording) => {
      shortcutRecording = recording
      registerShortcut()
      pushState()
    },
    setPrivacyMode: (enabled) => {
      container.hideFromScreenShare.isEnabled = enabled
      panel?.setContentProtection(enabled)
      pushState()
    },
    openNotificationSettings: () => void shell.openExternal('ms-settings:notifications'),
    commandLineInstall: () => commandLine.install(),
    commandLineUninstall: () => commandLine.uninstall(),
    demoReshuffle: () => demo?.reshuffle(),

    updaterCheck: () => updater.checkForUpdates(),
    updaterInstall: () => updater.installAvailableUpdate(),
    updaterDismiss: () => updater.dismissAvailableUpdate(),
    updaterSetAutomaticChecks: (enabled) => updater.setAutomaticChecks(enabled),
    updaterSetBetaChannel: (enabled) => updater.setBetaChannel(enabled),

    accountRename: (providerID, label) => {
      const account = container.accounts.account(providerID)
      if (account) container.accounts.rename(account.id, label)
    },
    accountRemove: (providerID) => {
      const account = container.accounts.account(providerID)
      if (account) container.accounts.remove(account.id)
    },
    accountReplaceKey: (providerID, key) => container.replaceKey(key, providerID) as unknown as void,
    hubReplaceKey: (hubID, key) => container.replaceHubKey(key, hubID) as unknown as void,
    hubRemove: (hubID) => container.hubs.remove(hubID),
    hubsSyncDue: (maxAgeSeconds) => void container.hubs.syncDue(maxAgeSeconds),

    addAccountOpen: (request) => openFlow(request.signingInAgainProviderID),
    addAccountClose: () => {
      flow?.cancel()
      flow = undefined
      pushState()
    },
    addAccountChoose: (kind) => flow?.choose(kind),
    addAccountChooseMethod: (method) => flow?.chooseMethod(method),
    addAccountChooseHub: () => flow?.chooseHub(),
    addAccountContinueToSignIn: (domain) => flow?.continueToSignIn(domain),
    addAccountChangeDomain: () => flow?.changeDomain(),
    addAccountSignIn: () => flow?.signIn(),
    addAccountOpenBrowser: () => flow?.openBrowser(),
    addAccountSubmitCode: (code) => flow?.submitCode(code),
    addAccountAddKey: (apiKey, accountName, organization) => flow?.addKey(apiKey, accountName, organization),
    addAccountConnectHub: (hubURL, apiKey) => flow?.connect(hubURL, apiKey),
    addAccountBack: () => flow?.back(),
    addAccountClearError: () => flow?.clearError(),

    refreshNow: () => void container.refreshNow(),
    refreshProviders: (providerIDs) => void container.dataStore.refreshMany(providerIDs, true),

    resetClaim: (providerID, expiry, requestID) =>
      (container.resetClaim(providerID)?.claim(expiry, requestID) ?? Promise.resolve({ type: 'noCredit' })) as unknown as ReturnType<Api['resetClaim']>,
    resetClaimWindow: (providerID, reset, requestID) =>
      (container.resetClaim(providerID)?.claimWindow(reset, requestID) ?? Promise.resolve({ type: 'noCredit' })) as unknown as ReturnType<Api['resetClaimWindow']>,

    panelSetHeight: (height) => panel?.setHeight(height) ?? { height, anchor: 'bottom' },
    panelMaxHeight: () => panel?.maxHeight ?? 800,
    panelHide: () => panel?.hide(),
    panelSetSticky: (sticky) => panel?.setSticky(sticky),
    openExternal: (url) => {
      if (/^(https?:|mailto:|ms-settings:)/i.test(url)) void shell.openExternal(url)
    },
    copyImage: async (dataURL) => {
      const image = nativeImage.createFromDataURL(dataURL)
      if (image.isEmpty()) {
        AppLog.error('lifecycle', 'share card: the picture was empty')
        shell.beep()
        return false
      }
      try {
        const png = new Blob([new Uint8Array(image.toPNG())], { type: 'image/png' })
        await clipboard.write([new ClipboardItem({ 'image/png': png })])
        return true
      } catch (error) {
        AppLog.error('lifecycle', `share card: could not copy the picture: ${describeError(error)}`)
        shell.beep()
        return false
      }
    },
    copyText: (text) => {
      void clipboard.writeText(text)
    },
    showMenu: (items) =>
      (panel
        ? panel.holdingOpen(
            () =>
              new Promise<string | undefined>((resolve) => {
                let chosen: string | undefined
                const menu = Menu.buildFromTemplate(buildMenu(items, (id) => (chosen = id)))
                // The click handler runs before the menu reports it closed.
                menu.popup({ window: panel?.window, callback: () => setTimeout(() => resolve(chosen), 0) })
              })
          )
        : Promise.resolve(undefined)) as unknown as string | undefined,
    trayUpdate: (update) => {
      if (!tray) return
      const first = update.images[0]
      if (first) {
        const image = nativeImage.createEmpty()
        for (const entry of update.images) image.addRepresentation({ scaleFactor: entry.scaleFactor, dataURL: entry.dataURL })
        if (!image.isEmpty()) tray.setImage(image)
      }
      tray.setToolTip(update.tooltip.slice(0, 127))
    },
    showAbout: () => {
      const show = (): Promise<unknown> =>
        dialog.showMessageBox({
          type: 'info',
          title: `About ${AppInfo.name}`,
          message: `${AppInfo.name} ${AppInfo.version}`,
          detail: `Track your AI coding subscriptions from the Windows tray.\n\n${AppInfo.name} is an unofficial Windows port of ${AppInfo.upstreamName}, created by Robin Ebers and its maintainers (MIT license). It is not affiliated with or endorsed by ${AppInfo.upstreamName}.\n\n${AppInfo.upstreamURL}`,
          buttons: ['OK']
        })
      void (panel ? panel.holdingOpen(show) : show())
    },
    quit: () => app.quit()
  }

  ipcMain.handle(IpcChannels.call, async (event, method: ApiMethod, callArguments: unknown[]) => {
    if (!panel || event.sender !== panel.window.webContents) throw new Error('Not allowed.')
    const handler = (api as unknown as Record<string, ((...parameters: unknown[]) => unknown) | undefined>)[method]
    if (typeof handler !== 'function' || !Object.prototype.hasOwnProperty.call(api, method)) throw new Error(`Unknown call: ${String(method)}`)
    try {
      return await handler(...(Array.isArray(callArguments) ? callArguments : []))
    } catch (error) {
      throw new Error(describeError(error))
    }
  })

  // The tray icon and the panel

  const trayIcon = nativeImage.createFromPath(join(__dirname, '../../resources/tray.png'))
  tray = new Tray(trayIcon.isEmpty() ? nativeImage.createEmpty() : trayIcon.resize({ width: 16, height: 16 }))
  tray.setToolTip(AppInfo.name)
  tray.on('click', togglePanel)
  tray.on('right-click', () => {
    panel?.hide()
    tray?.popUpContextMenu(
      Menu.buildFromTemplate([
        { label: 'Settings', click: () => openPanel(undefined, 'settings') },
        { type: 'separator' },
        { label: `Quit ${AppInfo.name}`, click: () => app.quit() }
      ])
    )
  })

  panel = new PanelWindow(rendererEntry())
  panel.setContentProtection(defaults.get(HideFromScreenShareSetting.key) === true)
  panel.window.webContents.on('did-finish-load', pushState)

  registerShortcut()
  container.startRefreshing()
  updater.start()
  AppLog.info('lifecycle', 'tray icon ready')

  app.on('second-instance', () => openPanel())
  app.on('before-quit', () => {
    if (panel) panel.quitting = true
    container.dispose()
    if (defaults instanceof FileDefaults) defaults.flush()
  })
  app.on('will-quit', () => globalShortcut.unregisterAll())

  if (captureFolder !== undefined) void import('./capture').then((module) => module.capture(panel as PanelWindow, captureFolder, () => openPanel()))
  else if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) setTimeout(() => openPanel(), 800)
}

if (!app.requestSingleInstanceLock() && !isDemo) {
  app.quit()
} else {
  // A tray app has no window to close: it stays until Quit.
  app.on('window-all-closed', () => undefined)
  if (process.platform === 'darwin') app.dock?.hide()
  void app.whenReady().then(start)
}

export type { Defaults }
