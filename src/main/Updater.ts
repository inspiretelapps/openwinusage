import { app, dialog } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import electronUpdater from 'electron-updater'
import { AppInfo } from '@core/support/AppInfo'
import { AppLog, describeError } from '@core/support/AppLog'
import { defaultsBool, type Defaults } from '@core/support/Defaults'
import { Observable } from '@core/support/Observable'
import type { UpdaterState } from '@shared/ipc'

const betaKey = 'betaUpdatesEnabled'
const automaticKey = 'automaticUpdateChecks'
const checkEveryMs = 60 * 60 * 1000

/**
 * Self-updates from the port's own GitHub releases (electron-updater), standing in for Sparkle. It is
 * active only in an installed build that was published with an update feed; a local build has none,
 * so the Updates controls are disabled there. A scheduled check only raises the in-panel banner;
 * Install Update or Check for Updates downloads and offers to restart.
 */
export class UpdaterController extends Observable {
  private readonly updater = electronUpdater.autoUpdater
  private active = false
  private checking = false
  private status: UpdaterState['status'] = 'idle'
  private message: string | undefined
  private available: string | undefined
  private userInitiated = false
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(private readonly defaults: Defaults) {
    super()
  }

  get state(): UpdaterState {
    const state: UpdaterState = {
      isActive: this.active,
      canCheckForUpdates: this.active && !this.checking,
      betaChannelEnabled: defaultsBool(this.defaults, betaKey, false),
      automaticallyChecksForUpdates: this.active && defaultsBool(this.defaults, automaticKey, true),
      status: this.status
    }
    if (this.available !== undefined) state.availableUpdateVersion = this.available
    if (this.message !== undefined) state.message = this.message
    return state
  }

  start(): void {
    if (this.active) return
    if (!app.isPackaged || !existsSync(join(process.resourcesPath, 'app-update.yml'))) {
      AppLog.info('updates', 'disabled: no update feed (unpackaged or local build)')
      return
    }
    this.active = true
    this.updater.autoDownload = false
    this.updater.autoInstallOnAppQuit = true
    this.updater.allowPrerelease = defaultsBool(this.defaults, betaKey, false)
    this.updater.on('checking-for-update', () => this.set('checking'))
    this.updater.on('update-available', (info) => {
      this.checking = false
      this.available = info.version
      AppLog.info('updates', `found ${info.version}`)
      if (this.userInitiated) void this.download()
      else this.set('idle')
    })
    this.updater.on('update-not-available', () => {
      this.checking = false
      this.set('upToDate', `${AppInfo.name} is up to date.`)
      if (this.userInitiated) void dialog.showMessageBox({ type: 'info', message: `${AppInfo.name} is up to date.`, detail: `Version ${app.getVersion()} is the newest.` })
      this.userInitiated = false
    })
    this.updater.on('error', (error) => {
      this.checking = false
      AppLog.warn('updates', `check/download failed: ${describeError(error)}`)
      this.set('failed', 'The update check failed. Try again later.')
      this.userInitiated = false
    })
    this.updater.on('update-downloaded', (info) => {
      this.set('ready', `${AppInfo.name} ${info.version} is ready to install.`)
      this.userInitiated = false
      void dialog
        .showMessageBox({
          type: 'info',
          message: `${AppInfo.name} ${info.version} is ready`,
          detail: 'Restart to finish updating.',
          buttons: ['Restart Now', 'Later'],
          defaultId: 0,
          cancelId: 1
        })
        .then((answer) => {
          if (answer.response === 0) this.updater.quitAndInstall()
        })
    })
    AppLog.info('updates', 'started (feed present)')
    this.schedule()
    if (this.state.automaticallyChecksForUpdates) setTimeout(() => this.check(false), 15_000)
  }

  private set(status: UpdaterState['status'], message?: string): void {
    this.status = status
    this.message = message
    if (status === 'checking') this.checking = true
    this.notify()
  }

  private schedule(): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = setInterval(() => {
      if (this.state.automaticallyChecksForUpdates) this.check(false)
    }, checkEveryMs)
  }

  private check(userInitiated: boolean): void {
    if (!this.active || this.checking) return
    this.userInitiated = userInitiated
    this.updater.checkForUpdates().catch((error: unknown) => AppLog.warn('updates', `check failed: ${describeError(error)}`))
  }

  private async download(): Promise<void> {
    this.set('downloading', 'Downloading the update…')
    this.available = undefined
    try {
      await this.updater.downloadUpdate()
    } catch (error) {
      AppLog.warn('updates', `download failed: ${describeError(error)}`)
      this.set('failed', 'The update could not be downloaded. Try again later.')
    }
  }

  /** Check for Updates…: checks now, and downloads what it finds. */
  checkForUpdates(): void {
    this.check(true)
  }

  /** The banner's Install Update. */
  installAvailableUpdate(): void {
    if (!this.active) return
    this.userInitiated = true
    if (this.available !== undefined) void this.download()
    else this.check(true)
  }

  dismissAvailableUpdate(): void {
    this.available = undefined
    this.notify()
  }

  setAutomaticChecks(enabled: boolean): void {
    this.defaults.set(automaticKey, enabled)
    this.notify()
  }

  setBetaChannel(enabled: boolean): void {
    this.defaults.set(betaKey, enabled)
    this.updater.allowPrerelease = enabled
    AppLog.info('updates', `channel set to ${enabled ? 'early access' : 'stable'}`)
    this.notify()
  }
}
