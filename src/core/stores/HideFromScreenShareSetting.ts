import { defaultsBool, standardDefaults, type Defaults } from '../support/Defaults'
import { Observable } from '../support/Observable'

/**
 * The Privacy Mode setting and the live capture signal behind it. Capture is watched only while the
 * setting is on, with a short poll.
 */
export class HideFromScreenShareSetting extends Observable {
  static readonly key = 'hideUsageWhileScreenSharing'

  private enabled: boolean
  private concealing = false
  private pollTimer: ReturnType<typeof setInterval> | undefined

  constructor(
    private readonly defaults: Defaults = standardDefaults(),
    private readonly isScreenCaptured: () => boolean = () => false,
    private readonly pollSeconds = 3
  ) {
    super()
    this.enabled = defaultsBool(defaults, HideFromScreenShareSetting.key, false)
    if (this.enabled) this.startMonitoring()
  }

  get isEnabled(): boolean {
    return this.enabled
  }

  set isEnabled(value: boolean) {
    if (value === this.enabled) return
    this.enabled = value
    this.defaults.set(HideFromScreenShareSetting.key, value)
    if (value) this.startMonitoring()
    else this.stopMonitoring()
    this.notify()
  }

  /** Whether usage and account names are being hidden right now. */
  get isConcealing(): boolean {
    return this.concealing
  }

  dispose(): void {
    if (this.pollTimer !== undefined) clearInterval(this.pollTimer)
    this.pollTimer = undefined
  }

  refreshCaptureState(): void {
    const concealing = this.enabled && this.isScreenCaptured()
    if (concealing === this.concealing) return
    this.concealing = concealing
    this.notify()
  }

  private startMonitoring(): void {
    if (this.pollTimer !== undefined) return
    this.refreshCaptureState()
    this.pollTimer = setInterval(() => this.refreshCaptureState(), this.pollSeconds * 1000)
    // The poll must not keep a process alive on its own.
    ;(this.pollTimer as { unref?: () => void }).unref?.()
  }

  private stopMonitoring(): void {
    this.dispose()
    this.refreshCaptureState()
  }
}
