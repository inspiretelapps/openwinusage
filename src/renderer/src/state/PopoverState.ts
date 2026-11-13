import { DashboardTab } from '@core/models/DashboardTab'
import { TransientNotice } from '@core/stores/TransientNotice'
import { Observable } from '@core/support/Observable'

export type PopoverScreen = 'dashboard' | 'accounts' | 'settings'

export const PopoverScreen = {
  slideRank(screen: PopoverScreen): number {
    return screen === 'dashboard' ? 0 : screen === 'accounts' ? 1 : 2
  }
}

export type SettingsTab = 'general' | 'display' | 'alerts' | 'advanced'

export const SettingsTab = {
  allCases: ['general', 'display', 'alerts', 'advanced'] as const satisfies readonly SettingsTab[],

  title(tab: SettingsTab): string {
    return { general: 'General', display: 'Display', alerts: 'Alerts', advanced: 'Advanced' }[tab]
  },

  /** The SF Symbol upstream uses; `Icon` maps it. */
  symbol(tab: SettingsTab): string {
    return { general: 'gearshape', display: 'macwindow', alerts: 'bell', advanced: 'terminal' }[tab]
  }
}

/** The panel's screen and sheets. It lives in the panel only; nothing here is saved. */
export class PopoverState extends Observable {
  private currentScreen: PopoverScreen = 'dashboard'
  screenSlideFrom: PopoverScreen = 'dashboard'
  screenSlideID = 0
  private providerID: string | undefined
  private hubID: string | undefined
  private addingAccount = false
  private signingInAgain: string | undefined
  private tab: DashboardTab = 'priority'
  private settings: SettingsTab = 'general'
  private shown = false

  readonly shareNotice = new TransientNotice<boolean>(false, 2.5)

  constructor() {
    super()
    this.shareNotice.subscribe(() => this.notify())
  }

  get screen(): PopoverScreen {
    return this.currentScreen
  }
  set screen(screen: PopoverScreen) {
    if (screen === this.currentScreen) return
    this.screenSlideFrom = this.currentScreen
    this.screenSlideID += 1
    this.currentScreen = screen
    if (screen !== 'accounts') {
      this.providerID = undefined
      this.hubID = undefined
      this.addingAccount = false
    }
    this.notify()
  }

  /** The account whose page Accounts shows. */
  get customizeProviderID(): string | undefined {
    return this.providerID
  }
  set customizeProviderID(id: string | undefined) {
    this.providerID = id
    this.notify()
  }

  /** The CLIProxyAPI hub whose page Accounts shows. An account opened from it goes back to it. */
  get customizeHubID(): string | undefined {
    return this.hubID
  }
  set customizeHubID(id: string | undefined) {
    this.hubID = id
    this.notify()
  }

  get isAddingAccount(): boolean {
    return this.addingAccount
  }
  set isAddingAccount(value: boolean) {
    this.addingAccount = value
    if (!value) this.signingInAgain = undefined
    this.notify()
  }

  /** The account the Add Account sheet signs in again, in place of adding a new one. */
  get signingInAgainProviderID(): string | undefined {
    return this.signingInAgain
  }
  set signingInAgainProviderID(id: string | undefined) {
    this.signingInAgain = id
    this.notify()
  }

  get dashboardTab(): DashboardTab {
    return this.tab
  }
  set dashboardTab(tab: DashboardTab) {
    this.tab = tab
    this.notify()
  }

  get settingsTab(): SettingsTab {
    return this.settings
  }
  set settingsTab(tab: SettingsTab) {
    this.settings = tab
    this.notify()
  }

  /** Whether the panel is on-screen. */
  get popoverShown(): boolean {
    return this.shown
  }
  set popoverShown(shown: boolean) {
    this.shown = shown
    this.notify()
  }

  back(): boolean {
    if (this.providerID !== undefined) {
      this.providerID = undefined
      this.notify()
      return true
    }
    if (this.hubID !== undefined) {
      this.hubID = undefined
      this.notify()
      return true
    }
    if (this.currentScreen === 'dashboard') return false
    this.screen = 'dashboard'
    return true
  }

  toggle(target: PopoverScreen): void {
    this.screen = this.currentScreen === target ? 'dashboard' : target
  }

  openAccounts(providerID: string | undefined): void {
    this.providerID = providerID
    this.hubID = undefined
    if (this.currentScreen === 'accounts') this.notify()
    else this.screen = 'accounts'
  }

  showDashboard(tab: DashboardTab): void {
    this.tab = tab
    if (this.currentScreen === 'dashboard') this.notify()
    else this.screen = 'dashboard'
  }

  show(dashboardTab: DashboardTab): void {
    this.tab = dashboardTab
    this.shown = true
    this.notify()
  }

  reset(): void {
    if (this.currentScreen !== 'dashboard') this.screen = 'dashboard'
    this.settings = 'general'
    this.shareNotice.clear()
    this.notify()
  }
}
