import { Account, AccountCredential } from '../models/Account'
import { DashboardTab } from '../models/DashboardTab'
import { Provider } from '../models/Provider'
import type { ProviderSnapshot } from '../models/ProviderSnapshot'
import { AccountProviderRuntime } from '../providers/AccountProviderRuntime'
import { ProviderCatalog } from '../providers/ProviderCatalog'
import { ProviderError } from '../providers/ProviderError'
import type { ProviderRuntime } from '../providers/ProviderRuntime'
import { ClaudeSessions } from '../providers/claude/ClaudeSession'
import { ProvisionalCredentialVault } from '../services/AccountCredentialVault'
import { CLIProxyHubClient, CLIProxyHubGate } from '../services/CLIProxyHubClient'
import type { HTTPClient } from '../services/HTTPClient'
import type { ResetClaimService } from '../services/ResetClaimService'
import type { AccountStore } from '../stores/AccountStore'
import { CLIProxyHubSync } from '../stores/CLIProxyHubSync'
import { HideFromScreenShareSetting } from '../stores/HideFromScreenShareSetting'
import { LayoutStore } from '../stores/LayoutStore'
import { ProviderSnapshotCache } from '../stores/ProviderSnapshotCache'
import { QuotaNotificationEvaluator, type NotificationPoster } from '../stores/QuotaNotificationEvaluator'
import { RefreshSetting } from '../stores/RefreshSetting'
import { WidgetDataStore } from '../stores/WidgetDataStore'
import { WidgetRegistry } from '../stores/WidgetRegistry'
import { AppInfo } from '../support/AppInfo'
import { defaultsBool, standardDefaults, type Defaults } from '../support/Defaults'
import { Observable } from '../support/Observable'
import { PaceMilestone } from '../support/PaceNotificationLogic'
import type { Clock } from '../support/time'

/** Builds the runtimes for the current accounts, reusing the ones that still fit. */
export type RuntimeFactory = (accounts: readonly Account[], existing: ProviderRuntime[]) => ProviderRuntime[]

/**
 * The composition root: owns the long-lived stores and the refresh loop. Accounts are the source of
 * truth; every `AccountStore` change swaps the runtimes in place and refreshes new ones.
 */
export class AppContainer extends Observable {
  readonly accounts: AccountStore
  readonly layout: LayoutStore
  readonly dataStore: WidgetDataStore
  readonly hideFromScreenShare: HideFromScreenShareSetting
  readonly hubs: CLIProxyHubSync
  isRefreshingNow = false
  /** Called when a new sign-in for an existing account reads usage, so the panel can return to the dashboard. */
  onSignedInAgain: ((tab: DashboardTab) => void) | undefined
  /** Called when an account's page is open for an account that no longer exists. */
  onAccountsChanged: ((registry: WidgetRegistry) => void) | undefined

  private providers: ProviderRuntime[]
  private readonly makeRuntimes: RuntimeFactory
  private refreshTimer: ReturnType<typeof setTimeout> | undefined
  private refreshLoopRunning = false
  private refreshLoopGeneration = 0

  private readonly defaults: Defaults
  private readonly claudeSessions: ClaudeSessions
  private readonly hubGate = new CLIProxyHubGate()
  private readonly quotaNotifications: QuotaNotificationEvaluator
  private readonly now: Clock

  constructor(options: {
    accounts: AccountStore
    defaults?: Defaults
    http: HTTPClient
    runtimeFactory?: RuntimeFactory
    postNotification?: NotificationPoster
    isScreenCaptured?: () => boolean
    now?: Clock
  }) {
    super()
    const { accounts, http } = options
    const defaults = options.defaults ?? standardDefaults()
    this.accounts = accounts
    this.defaults = defaults
    this.now = options.now ?? Date.now
    this.hideFromScreenShare = new HideFromScreenShareSetting(defaults, options.isScreenCaptured)
    const claudeSessions = new ClaudeSessions(defaults)
    this.claudeSessions = claudeSessions
    const hubGate = this.hubGate
    this.makeRuntimes =
      options.runtimeFactory ??
      ((currentAccounts, existing) =>
        ProviderCatalog.make({
          accounts: [...currentAccounts],
          vault: accounts.credentialVault,
          hubKeys: accounts.hubKeys,
          http,
          hubGate,
          claudeSessions,
          reusing: existing.filter((runtime): runtime is AccountProviderRuntime => runtime instanceof AccountProviderRuntime)
        }))
    const providers = this.makeRuntimes(accounts.accounts, [])
    const registry = WidgetRegistry.from(providers)
    this.providers = providers
    this.layout = new LayoutStore(registry, defaults)
    this.dataStore = new WidgetDataStore({ registry, providers, cache: new ProviderSnapshotCache(defaults), defaults, now: this.now })
    this.hubs = new CLIProxyHubSync(accounts, new CLIProxyHubClient(http, hubGate))
    this.quotaNotifications = new QuotaNotificationEvaluator(options.postNotification ?? (async () => false))
    accounts.didChange = () => this.syncAccounts()
  }

  get runtimes(): readonly ProviderRuntime[] {
    return this.providers
  }

  dispose(): void {
    this.stopRefreshing()
    this.hideFromScreenShare.dispose()
  }

  private runtime(providerID: string): AccountProviderRuntime | undefined {
    const runtime = this.providers.find((candidate) => candidate.provider.id === providerID)
    return runtime instanceof AccountProviderRuntime ? runtime : undefined
  }

  resetClaim(providerID: string): ResetClaimService | undefined {
    const runtime = this.runtime(providerID)
    if (!runtime) return undefined
    const rereadsResets = runtime.account.kind === 'zai'
    return runtime.resetClaimService(() => this.dataStore.refresh(providerID, true, rereadsResets))
  }

  /**
   * Saves a pasted key only once the account's usage read accepts it and the account is still added,
   * so a refused key never replaces one that works and a removed account's key never comes back.
   */
  async replaceKey(key: string, providerID: string): Promise<void> {
    await this.replaceCredential(AccountCredential.apiKey(key.trim()), providerID)
  }

  /** Keeps the account, its name and its place: only the sign-in changes, once its usage read works. */
  async replaceCredential(credential: AccountCredential, providerID: string, signal?: AbortSignal): Promise<void> {
    const runtime = this.runtime(providerID)
    if (!runtime) return
    const account = runtime.account
    if (credential.type === 'oauth') {
      const signedIn = AccountCredential.identity(credential)
      let saved: string | undefined
      try {
        const stored = this.accounts.credential(account.id)
        saved = stored ? AccountCredential.identity(stored) : undefined
      } catch {
        saved = undefined
      }
      if (signedIn !== undefined && saved !== undefined && saved !== signedIn) {
        throw ProviderError.unavailable("That's a different account. Sign in to this one, or use Add New Account.")
      }
    }
    this.accounts.checkForDuplicate(credential, account.kind, account.organization, account.id)
    // The new sign-in reads into its own runtime and vault: the previous sign-in's history and plan
    // can't be reused, and a refused token can't fall back on the stored one.
    const provisional = new ProvisionalCredentialVault(credential)
    const replacement = new AccountProviderRuntime(account, provisional, runtime.http, this.now, this.claudeSessions)
    replacement.isCheckingNewSignIn = true
    let snapshot: ProviderSnapshot
    try {
      snapshot = await replacement.readSnapshot(credential)
    } catch (error) {
      if (ProviderError.is(error, 'keyRejected')) throw ProviderError.unavailable(error.case.message)
      throw error
    }
    const cancelled = (): Error => new DOMException('The sign-in was cancelled.', 'AbortError')
    if (signal?.aborted) throw cancelled()
    await runtime.stopRenewals()
    try {
      if (signal?.aborted) throw cancelled()
      const index = this.providers.findIndex((candidate) => candidate.provider.id === providerID)
      if (index < 0) return
      if (this.providers[index] !== runtime) {
        throw ProviderError.unavailable(`This account’s sign-in changed while ${AppInfo.name} was checking it. Try again.`)
      }
      // A read can renew the sign-in, so what's saved is what the read ended on.
      this.accounts.replaceCredential(provisional.load() ?? credential, account.id)
      replacement.adopt(this.accounts.credentialVault)
      replacement.update(runtime.account) // The account may have been renamed during the read.
      this.providers[index] = replacement
      this.dataStore.replaceProvider(replacement, snapshot)
    } catch (error) {
      runtime.resumeRenewals()
      throw error
    }
  }

  /** Once the new sign-in reads usage, the sign-in sheet closes and the panel shows the Default Tab. */
  async signInAgain(credential: AccountCredential, providerID: string, signal?: AbortSignal): Promise<void> {
    await this.replaceCredential(credential, providerID, signal)
    this.onSignedInAgain?.(DashboardTab.preferred(this.defaults))
  }

  /** Saves a hub's new management key once the hub accepts it, then refreshes the hub's accounts. */
  async replaceHubKey(key: string, hubID: string): Promise<void> {
    await this.hubs.replaceKey(key, hubID)
    const ids = new Set(this.accounts.accountsOnHub(hubID).map((account) => Account.cardID(account)))
    await this.dataStore.refreshMany(
      this.providers.map((runtime) => runtime.provider.id).filter((id) => ids.has(id)),
      true
    )
  }

  /**
   * The Refresh button: every hub's login list is read first, so a login turned off on its hub is gone
   * before the usage read instead of failing in it. A press while one runs does nothing.
   */
  async refreshNow(): Promise<void> {
    if (this.isRefreshingNow) return
    this.isRefreshingNow = true
    this.notify()
    try {
      await this.hubs.syncDue(0)
      await this.dataStore.refreshAll(true)
    } finally {
      this.isRefreshingNow = false
      this.notify()
    }
  }

  /** One pass of the loop: hubs, usage, then notifications. */
  async refreshPass(): Promise<void> {
    await this.hubs.syncDue()
    await this.dataStore.refreshAll()
    await this.quotaNotifications.evaluate(
      this.layout.visibleDescriptors,
      (descriptor) => this.dataStore.data(descriptor),
      (milestone) => defaultsBool(this.defaults, PaceMilestone.settingKey(milestone), false),
      Date.now(),
      (id) => {
        const provider = this.layout.provider(id)
        return provider ? Provider.fullName(provider) : id
      }
    )
  }

  /**
   * Runs at launch and then every refresh interval. Halfway between passes, the hourly reads run: reads
   * a provider must not get in the same burst as usage. A pass missed while the computer slept runs on
   * wake, because each wait is measured against the wall clock when it ends.
   */
  startRefreshing(): void {
    if (this.refreshLoopRunning) return
    this.refreshLoopRunning = true
    const generation = ++this.refreshLoopGeneration
    const alive = (): boolean => this.refreshLoopRunning && this.refreshLoopGeneration === generation
    const sleepUntil = (deadline: number): Promise<void> =>
      new Promise((resolve) => {
        this.refreshTimer = setTimeout(resolve, Math.max(0, deadline - Date.now()))
      })
    void (async (): Promise<void> => {
      while (alive()) {
        await this.refreshPass()
        const next = Date.now() + RefreshSetting.interval * 1000
        await sleepUntil(next - (RefreshSetting.interval / 2) * 1000)
        if (!alive()) return
        await this.dataStore.refreshHourlyReads()
        await sleepUntil(next)
      }
    })()
  }

  stopRefreshing(): void {
    this.refreshLoopRunning = false
    if (this.refreshTimer !== undefined) clearTimeout(this.refreshTimer)
    this.refreshTimer = undefined
  }

  /** When the next scheduled pass is due: one interval after the last one ended. */
  get nextRefreshAt(): number | undefined {
    const last = this.dataStore.lastRefreshAt
    return last === undefined ? undefined : last + RefreshSetting.interval * 1000
  }

  private syncAccounts(): void {
    const previous = new Set(this.providers)
    this.providers = this.makeRuntimes(this.accounts.accounts, this.providers)
    const registry = WidgetRegistry.from(this.providers)
    this.layout.apply(registry)
    this.onAccountsChanged?.(registry)
    this.dataStore.apply(this.providers, registry)
    for (const runtime of this.providers) {
      if (!previous.has(runtime)) void this.dataStore.refresh(runtime.provider.id, true)
    }
    this.notify()
  }
}
