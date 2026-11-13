import { AppLog, describeError } from '../support/AppLog'
import { Observable } from '../support/Observable'

/** Whether the app starts when the user signs in to Windows. The system's own setting is the source of truth. */
export class LaunchAtLoginSetting extends Observable {
  static readonly failureMessage = "Windows wouldn't update Launch at Login. Check Settings → Apps → Startup."

  isEnabled: boolean
  errorMessage: string | undefined

  constructor(
    private readonly currentStatus: () => boolean,
    private readonly setSystemEnabled: (enabled: boolean) => void
  ) {
    super()
    this.isEnabled = currentStatus()
  }

  refreshStatus(): void {
    const enabled = this.currentStatus()
    if (enabled === this.isEnabled) return
    this.isEnabled = enabled
    this.errorMessage = undefined
    this.notify()
  }

  update(enabled: boolean): void {
    if (enabled === this.isEnabled) return
    try {
      this.setSystemEnabled(enabled)
      this.isEnabled = this.currentStatus()
      this.errorMessage = undefined
    } catch (error) {
      AppLog.error('config', `Launch at Login ${enabled ? 'register' : 'unregister'} failed: ${describeError(error)}`)
      this.isEnabled = this.currentStatus()
      this.errorMessage = LaunchAtLoginSetting.failureMessage
    }
    this.notify()
  }
}
