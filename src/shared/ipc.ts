import type { AddAccountFlowState } from '@core/models/AddAccountChoice'
import type { ProviderAuthMethod, ProviderKind } from '@core/models/Account'
import type { DashboardTab } from '@core/models/DashboardTab'
import type { ZAIReset } from '@core/providers/zai/ZAIResets'
import type { ResetClaimOutcome } from '@core/services/ResetClaimService'
import type { HubSyncStatus } from '@core/stores/CLIProxyHubSync'
import type { RefreshBackoff } from '@core/stores/RefreshBackoff'

/** The app's whole state as the panel needs it. The app sends a fresh one after every change. */
export interface AppState {
  /**
   * The preferences: accounts, hubs, the layout, the last readings, and every setting. The panel
   * rebuilds its read-only stores from this with the same code the app runs.
   */
  defaults: Record<string, unknown>
  backoffs: Record<string, RefreshBackoff>
  refreshingProviderIDs: string[]
  lastRefreshAt?: number
  burningFastWindows: Record<string, number>
  isRefreshingNow: boolean
  canUndo: boolean
  accountsLastError?: string
  hubStatuses: Record<string, HubSyncStatus>
  /** Per account that can spend rate-limit resets (Claude, ChatGPT, Z.ai). */
  resetClaims: Record<string, ResetClaimInfo>
  /** The Add Account sheet's flow while the sheet is open. */
  addAccount?: AddAccountFlowState
  privacyMode: { isEnabled: boolean; isConcealing: boolean }
  updater: UpdaterState
  launchAtLogin: { isEnabled: boolean; errorMessage?: string }
  shortcut: { accelerator?: string; errorMessage?: string }
  commandLine: CommandLineState
  demo?: { seed: number }
  app: AppMeta
  /** Whether Windows is in dark mode, for the System theme. */
  systemDark: boolean
  reduceMotion: boolean
}

export interface AppMeta {
  name: string
  version: string
  commandName: string
  isPackaged: boolean
  platform: string
  issuesURL: string
  upstreamName: string
  upstreamURL: string
}

export interface ResetClaimInfo {
  isClaimable: boolean
  confirmDetail?: string
  windowResets: ZAIReset[]
}

export interface UpdaterState {
  /** Whether this build can update itself at all: a packaged build with an update feed. */
  isActive: boolean
  canCheckForUpdates: boolean
  availableUpdateVersion?: string
  betaChannelEnabled: boolean
  automaticallyChecksForUpdates: boolean
  /** What the updater is doing, for the Settings row. */
  status: 'idle' | 'checking' | 'downloading' | 'ready' | 'upToDate' | 'failed'
  message?: string
}

export type CommandLineStatus = 'notInstalled' | 'installed' | 'unavailable'

export interface CommandLineState {
  status: CommandLineStatus
  /** The folder Install puts on the user's PATH. */
  folder: string
  errorMessage?: string
}

/** One entry of a native menu the panel asks the app to show. */
export interface MenuItemSpec {
  id?: string
  label?: string
  type?: 'normal' | 'separator' | 'checkbox'
  enabled?: boolean
  checked?: boolean
  /** A hint shown beside the label, like `Ctrl+R`. It is a label only; the panel handles the key itself. */
  accelerator?: string
  /** A dimmed, unclickable line: the reason an account failed, at the top of its menu. */
  isInformational?: boolean
  submenu?: MenuItemSpec[]
}

export interface TrayIconUpdate {
  /** PNG data URLs of the 16pt icon, by scale factor (1, 1.25, 1.5, 2, ...). */
  images: { scaleFactor: number; dataURL: string }[]
  tooltip: string
}

export interface StartLoginRequest {
  signingInAgainProviderID?: string
}

/** Everything the panel can ask the app to do. Each is one IPC round trip; errors reject with the message to show. */
export interface Api {
  getState(): AppState

  // Layout
  layoutSetMetricShown(descriptorID: string, shown: boolean): boolean
  layoutSetMetricPinned(descriptorID: string, pinned: boolean): boolean
  layoutReorderProvider(dragged: string, target: string): boolean
  layoutReorderFamily(dragged: string, target: string): boolean
  layoutReorderMetric(dragged: string, target: string, providerID: string): boolean
  layoutUndo(): boolean

  // Settings
  /** Saves one preference and applies it. Only keys the app knows are accepted. */
  setSetting(key: string, value: unknown): void
  setLaunchAtLogin(enabled: boolean): void
  /** Registers the global shortcut (an Electron accelerator such as `Control+Alt+U`), or clears it with undefined. */
  setShortcut(accelerator: string | undefined): void
  /** While the shortcut field is recording, the current shortcut is switched off so its keys can be typed. */
  setShortcutRecording(recording: boolean): void
  setPrivacyMode(enabled: boolean): void
  openNotificationSettings(): void
  commandLineInstall(): void
  commandLineUninstall(): void
  demoReshuffle(): void

  // Updates
  updaterCheck(): void
  updaterInstall(): void
  updaterDismiss(): void
  updaterSetAutomaticChecks(enabled: boolean): void
  updaterSetBetaChannel(enabled: boolean): void

  // Accounts
  accountRename(providerID: string, label: string): void
  accountRemove(providerID: string): void
  accountReplaceKey(providerID: string, key: string): void
  hubReplaceKey(hubID: string, key: string): void
  hubRemove(hubID: string): void
  hubsSyncDue(maxAgeSeconds: number): void

  // Add Account sheet
  addAccountOpen(request: StartLoginRequest): void
  addAccountClose(): void
  addAccountChoose(kind: ProviderKind): void
  addAccountChooseMethod(method: ProviderAuthMethod): void
  addAccountChooseHub(): void
  addAccountContinueToSignIn(domain: string): void
  addAccountChangeDomain(): void
  addAccountSignIn(): void
  addAccountOpenBrowser(): void
  addAccountSubmitCode(code: string): void
  addAccountAddKey(apiKey: string, accountName: string, organization: string): void
  addAccountConnectHub(hubURL: string, apiKey: string): void
  addAccountBack(): void
  addAccountClearError(): void

  // Refreshing
  refreshNow(): void
  /** An account's or provider's Refresh menu item: these accounts, skipping the cache. */
  refreshProviders(providerIDs: string[]): void

  // Rate-limit resets
  resetClaim(providerID: string, creditExpiringAt: number, redeemRequestID: string): ResetClaimOutcome
  resetClaimWindow(providerID: string, reset: ZAIReset, requestID: string): ResetClaimOutcome

  // Panel and system
  /** The height the panel's content wants, in CSS pixels; the app clamps it to the screen and answers what it applied and which edge stays put. */
  panelSetHeight(height: number): { height: number; anchor: 'top' | 'bottom' }
  /** The tallest the panel may be where it is anchored. */
  panelMaxHeight(): number
  panelHide(): void
  /** While true the panel stays open when it loses focus: a sign-in sends the user to their browser. */
  panelSetSticky(sticky: boolean): void
  openExternal(url: string): void
  /** Copies a PNG (a data URL) to the clipboard. */
  copyImage(dataURL: string): Promise<boolean>
  copyText(text: string): void
  /** Shows a native menu at the pointer and answers the chosen item's id, or undefined when dismissed. */
  showMenu(items: MenuItemSpec[]): string | undefined
  trayUpdate(update: TrayIconUpdate): void
  showAbout(): void
  quit(): void
}

export type ApiMethod = keyof Api

/** What the app tells the panel outside of state. */
export type PanelEvent =
  | { type: 'shown'; tab: DashboardTab; screen?: 'dashboard' | 'settings' }
  | { type: 'hidden' }
  | { type: 'openSettings' }

/** The object the preload script puts on `window.winusage`. */
export interface Bridge {
  call<M extends ApiMethod>(method: M, ...args: Parameters<Api[M]>): Promise<Awaited<ReturnType<Api[M]>>>
  onState(listener: (state: AppState) => void): () => void
  onEvent(listener: (event: PanelEvent) => void): () => void
}

export const IpcChannels = {
  call: 'winusage:call',
  state: 'winusage:state',
  event: 'winusage:event'
} as const
