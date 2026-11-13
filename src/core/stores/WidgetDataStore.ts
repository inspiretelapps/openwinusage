import { BurningFast } from '../models/BurningFast'
import { DashboardAccount, DashboardFamily, type DashboardLine, type ProviderMetrics } from '../models/DashboardFamilies'
import { MenuBarLimit } from '../models/MenuBarLimit'
import { MetricLine, ProgressFormat } from '../models/MetricLine'
import { PriorityBoard } from '../models/PriorityBoard'
import { Provider } from '../models/Provider'
import { PriorityLimits } from '../models/PriorityLimits'
import { ProviderSnapshot, type RefreshFailure, type RefreshResult } from '../models/ProviderSnapshot'
import { ResetDisplayMode } from '../models/ResetDisplayMode'
import type { UsageBreakdown } from '../models/UsageHistory'
import { WidgetData } from '../models/WidgetData'
import type { WidgetDescriptor } from '../models/WidgetDescriptor'
import { WidgetDisplayMode } from '../models/WidgetDisplayMode'
import type { ProviderRuntime } from '../providers/ProviderRuntime'
import { AppInfo } from '../support/AppInfo'
import { AppLog } from '../support/AppLog'
import { defaultsBool, defaultsEnum, defaultsNumber, standardDefaults, type Defaults } from '../support/Defaults'
import { Formatters } from '../support/Formatters'
import { Observable } from '../support/Observable'
import { ProviderParse } from '../support/ProviderParse'
import { secondsBetween, type Clock, type Instant, type Seconds } from '../support/time'
import { ProviderRefreshDeadline } from './ProviderRefreshDeadline'
import { ProviderSnapshotCache } from './ProviderSnapshotCache'
import { RefreshBackoff } from './RefreshBackoff'
import type { RefreshOutcome } from './RefreshOutcome'
import { RefreshSetting } from './RefreshSetting'
import type { WidgetRegistry } from './WidgetRegistry'

/** The preference keys of the display settings. */
export const DisplaySettingKeys = {
  meterStyle: 'meterStyle',
  resetDisplayMode: 'resetDisplayMode',
  menuBarLimit: 'menuBarLimit',
  menuBarAlwaysShows: 'menuBarAlwaysShows',
  priorityWarning: 'priorityWarning',
  priorityCritical: 'priorityCritical',
  priorityBurningFast: 'priorityBurningFast',
  priorityUseItOrLoseIt: 'priorityUseItOrLoseIt',
  paceMarks: 'paceMarks'
} as const

/**
 * The reading side of `WidgetDataStore`: everything the dashboard computes from the latest snapshots,
 * the refresh errors, and the display settings. The app's store extends it with the refresh loop; the
 * panel builds one from the state the app sends it, so both draw from the same code.
 */
export class WidgetDataView extends Observable {
  protected registry: WidgetRegistry
  protected readonly defaults: Defaults
  protected readonly now: Clock

  protected snapshotsByID: Record<string, ProviderSnapshot> = {}
  protected backoffsByID: Record<string, RefreshBackoff> = {}
  protected refreshingIDs = new Set<string>()
  lastRefreshAt: Instant | undefined

  /** The limits that were burning fast at their last reading, with their window's reset. See `BurningFast`. */
  protected burningFastWindowsByID = new Map<string, Instant>()

  private meterStyleValue: WidgetDisplayMode
  private resetDisplayModeValue: ResetDisplayMode
  private menuBarLimitValue: MenuBarLimit
  private menuBarAlwaysShowsValue: boolean
  private priorityLimitsValue: PriorityLimits
  private showsBurningFastValue: boolean
  private showsUseItOrLoseItValue: boolean
  private showsPaceMarksValue: boolean

  constructor(registry: WidgetRegistry, defaults: Defaults = standardDefaults(), now: Clock = Date.now) {
    super()
    this.registry = registry
    this.defaults = defaults
    this.now = now
    const keys = DisplaySettingKeys
    this.meterStyleValue = defaultsEnum(defaults, keys.meterStyle, WidgetDisplayMode.allCases, 'remaining')
    this.resetDisplayModeValue = defaultsEnum(defaults, keys.resetDisplayMode, ResetDisplayMode.allCases, 'relative')
    this.menuBarLimitValue = defaultsEnum(defaults, keys.menuBarLimit, MenuBarLimit.allCases, 'upToThree')
    this.menuBarAlwaysShowsValue = defaultsBool(defaults, keys.menuBarAlwaysShows, false)
    this.priorityLimitsValue = PriorityLimits.make(
      defaultsNumber(defaults, keys.priorityWarning) ?? PriorityLimits.standard.warning,
      defaultsNumber(defaults, keys.priorityCritical) ?? PriorityLimits.standard.critical
    )
    this.showsBurningFastValue = defaultsBool(defaults, keys.priorityBurningFast, true)
    this.showsUseItOrLoseItValue = defaultsBool(defaults, keys.priorityUseItOrLoseIt, true)
    this.showsPaceMarksValue = defaultsBool(defaults, keys.paceMarks, false)
  }

  /**
   * Fills a view with state read elsewhere: the panel's mirror of the app's store. `burningFastWindows`
   * is taken as given, since the app latched it when the readings arrived.
   */
  hydrate(state: {
    snapshots: Record<string, ProviderSnapshot>
    backoffs: Record<string, RefreshBackoff>
    refreshingProviderIDs: string[]
    lastRefreshAt?: Instant
    burningFastWindows: Record<string, Instant>
  }): void {
    this.snapshotsByID = state.snapshots
    this.backoffsByID = state.backoffs
    this.refreshingIDs = new Set(state.refreshingProviderIDs)
    this.lastRefreshAt = state.lastRefreshAt
    this.burningFastWindowsByID = new Map(Object.entries(state.burningFastWindows))
  }

  get snapshots(): Readonly<Record<string, ProviderSnapshot>> {
    return this.snapshotsByID
  }

  get backoffs(): Readonly<Record<string, RefreshBackoff>> {
    return this.backoffsByID
  }

  get refreshingProviderIDs(): Set<string> {
    return new Set(this.refreshingIDs)
  }

  get burningFastWindows(): Map<string, Instant> {
    return this.burningFastWindowsByID
  }

  // Display settings. Each write is saved at once.

  get meterStyle(): WidgetDisplayMode {
    return this.meterStyleValue
  }
  set meterStyle(value: WidgetDisplayMode) {
    this.meterStyleValue = value
    this.defaults.set(DisplaySettingKeys.meterStyle, value)
    this.settingsChanged()
  }

  get resetDisplayMode(): ResetDisplayMode {
    return this.resetDisplayModeValue
  }
  set resetDisplayMode(value: ResetDisplayMode) {
    this.resetDisplayModeValue = value
    this.defaults.set(DisplaySettingKeys.resetDisplayMode, value)
    this.settingsChanged()
  }

  get menuBarLimit(): MenuBarLimit {
    return this.menuBarLimitValue
  }
  set menuBarLimit(value: MenuBarLimit) {
    this.menuBarLimitValue = value
    this.defaults.set(DisplaySettingKeys.menuBarLimit, value)
    this.settingsChanged()
  }

  /** The tray lists every Priority section in the tab's order instead of only what's running out. */
  get menuBarAlwaysShows(): boolean {
    return this.menuBarAlwaysShowsValue
  }
  set menuBarAlwaysShows(value: boolean) {
    this.menuBarAlwaysShowsValue = value
    this.defaults.set(DisplaySettingKeys.menuBarAlwaysShows, value)
    this.settingsChanged()
  }

  get priorityLimits(): PriorityLimits {
    return this.priorityLimitsValue
  }
  set priorityLimits(value: PriorityLimits) {
    this.priorityLimitsValue = value
    this.defaults.set(DisplaySettingKeys.priorityWarning, value.warning)
    this.defaults.set(DisplaySettingKeys.priorityCritical, value.critical)
    this.settingsChanged()
  }

  /** Priority lists limits that would run out before they reset, however much they have left. */
  get showsBurningFast(): boolean {
    return this.showsBurningFastValue
  }
  set showsBurningFast(value: boolean) {
    this.showsBurningFastValue = value
    this.defaults.set(DisplaySettingKeys.priorityBurningFast, value)
    this.settingsChanged()
  }

  /** Priority lists limits with over half left that reset within a day, the same rule as the Use It or Lose It alert. */
  get showsUseItOrLoseIt(): boolean {
    return this.showsUseItOrLoseItValue
  }
  set showsUseItOrLoseIt(value: boolean) {
    this.showsUseItOrLoseItValue = value
    this.defaults.set(DisplaySettingKeys.priorityUseItOrLoseIt, value)
    this.settingsChanged()
  }

  /** Bars and Priority's rings mark where usage would be at an even pace through the window. */
  get showsPaceMarks(): boolean {
    return this.showsPaceMarksValue
  }
  set showsPaceMarks(value: boolean) {
    this.showsPaceMarksValue = value
    this.defaults.set(DisplaySettingKeys.paceMarks, value)
    this.settingsChanged()
  }

  protected settingsChanged(): void {
    this.notify()
  }

  /** What Priority and the tray list as burning fast, or undefined while the setting is off. */
  get burningFast(): BurningFast | undefined {
    return this.showsBurningFast ? new BurningFast(new Map(this.burningFastWindowsByID)) : undefined
  }

  errorMessage(providerID: string): string | undefined {
    const backoff = this.backoffsByID[providerID]
    return backoff && !backoff.providerAsked ? backoff.message : undefined
  }

  notice(providerID: string): string | undefined {
    return this.backoffsByID[providerID] === undefined ? this.snapshotsByID[providerID]?.notice : this.errorMessage(providerID)
  }

  usageBreakdown(descriptor: WidgetDescriptor): UsageBreakdown | undefined {
    return this.snapshotsByID[descriptor.providerID]?.usageBreakdowns?.[descriptor.key]
  }

  data(descriptor: WidgetDescriptor): WidgetData {
    let result: WidgetData | undefined
    const snapshot = this.snapshotsByID[descriptor.providerID]
    if (snapshot) {
      const line =
        ProviderSnapshot.line(snapshot, descriptor.metricLabel) ??
        (descriptor.unreportedValues ? MetricLine.values(descriptor.metricLabel, descriptor.unreportedValues) : undefined)
      const resolved = line ? this.resolve(line, descriptor) : undefined
      if (resolved) {
        result = resolved
        result.title = snapshot.lineTitles?.[descriptor.metricLabel] ?? result.title
      }
    }
    if (!result) result = descriptor.sample.with({ hasData: false })

    result.displayMode = this.meterStyle
    result.priorityLimits = this.priorityLimits
    result.resetDisplayMode = this.resetDisplayMode
    result.showsPaceMarks = this.showsPaceMarks
    return result
  }

  /** The accounts with their lines, in the order the dashboard shows them. */
  accounts(groups: ProviderMetrics[]): DashboardAccount[] {
    return this.families(groups).flatMap((family) => family.accounts)
  }

  families(groups: ProviderMetrics[]): DashboardFamily[] {
    return DashboardFamily.make(
      groups,
      (descriptor): DashboardLine => ({ descriptor, data: this.data(descriptor) }),
      (provider) => this.snapshotsByID[provider.id] === undefined && this.problem(provider.id) === undefined
    )
  }

  plan(providerID: string): string | undefined {
    return this.snapshotsByID[providerID]?.plan
  }

  /**
   * Why an account needs the user: Priority lists it under Needs Attention, and its page says why and offers Sign In Again.
   * Old values count only once a refresh has failed. Until then they are waiting for their next read, as on launch.
   */
  problem(providerID: string): string | undefined {
    return this.notice(providerID) ?? (this.backoffsByID[providerID] === undefined ? undefined : this.stalenessHint(providerID))
  }

  stalenessHint(providerID: string): string | undefined {
    const date = this.now()
    const backoff = this.backoffsByID[providerID]
    if (backoff && backoff.providerAsked && date < backoff.retryAt) {
      const provider = this.registry.provider(providerID)
      const name = provider ? Provider.displayName(provider) : 'The provider'
      return `${name} asked ${AppInfo.name} to wait. Retrying at ${Formatters.compactClock(backoff.retryAt, date)}.`
    }
    const snapshot = this.snapshotsByID[providerID]
    if (snapshot && ProviderSnapshot.isStale(snapshot, date)) {
      const duration = Formatters.compactDuration(secondsBetween(date, snapshot.refreshedAt))
      if (duration !== undefined) return `Last updated ${duration} ago`
    }
    return backoff?.providerAsked === true ? 'Waiting to retry after a rate limit.' : undefined
  }

  /** The limits that need the user, for the Priority tab and the tray. `hidingEmails` is for a picture to share. */
  priorityBoard(groups: ProviderMetrics[], pinned: Set<string> = new Set(), now: Instant = this.now(), hidingEmails = false): PriorityBoard {
    const accounts = this.accounts(groups)
    return PriorityBoard.make({
      accounts: hidingEmails ? accounts.map(DashboardAccount.hidingEmail) : accounts,
      pinned,
      burningFast: this.burningFast,
      useItOrLoseIt: this.showsUseItOrLoseIt,
      now,
      status: (account) => {
        const id = account.provider.id
        const message = this.problem(id)
        // A provider's notice can itself contain account details. Share only the status.
        if (message !== undefined) return { type: 'unavailable', message: hidingEmails ? 'Current usage unavailable.' : message }
        return this.snapshotsByID[id] === undefined ? { type: 'waiting' } : { type: 'current' }
      }
    })
  }

  private resolve(line: MetricLine, descriptor: WidgetDescriptor): WidgetData | undefined {
    switch (line.type) {
      case 'progress': {
        const normalizedUsed = line.format.type === 'percent' ? ProviderParse.clampPercent(line.used) : line.used
        return new WidgetData({
          title: descriptor.sample.title,
          kind: ProgressFormat.metricKind(line.format),
          currencyCode: ProgressFormat.currencyCode(line.format),
          used: normalizedUsed,
          limit: line.limit,
          resetsAt: line.resetsAt,
          periodDurationMs: line.periodDurationMs,
          sessionStartSignal: descriptor.sample.sessionStartSignal
        })
      }
      case 'values':
        return descriptor.sample.with({
          values: line.values,
          limit: undefined,
          expiriesAt: line.expiriesAt ?? [],
          hasData: line.values.length > 0
        })
      case 'badge':
        return descriptor.sample.with({ valueTextOverride: line.text })
    }
  }

  protected latchBurningFast(): void {
    const at = this.now()
    const previous = new BurningFast(new Map(this.burningFastWindowsByID))
    const burning = new Map<string, Instant>()
    for (const provider of this.registry.providers) {
      for (const descriptor of this.registry.descriptors(provider.id)) {
        const data = this.data(descriptor)
        if (data.resetsAt === undefined) continue
        if (!BurningFast.isBurning(data, at, previous.wasBurning(descriptor.id, data))) continue
        burning.set(descriptor.id, data.resetsAt)
      }
    }
    if (!new BurningFast(burning).equals(previous)) this.burningFastWindowsByID = burning
  }
}

type InFlight = Promise<RefreshResult>

/** The latest snapshot per account, refresh errors and waits, and the refreshes themselves. */
export class WidgetDataStore extends WidgetDataView {
  static readonly slowProviderRefreshThreshold: Seconds = 10
  static readonly defaultProviderRefreshTimeout: Seconds = 120

  private providersByID = new Map<string, ProviderRuntime>()
  private readonly cache: ProviderSnapshotCache
  private readonly providerRefreshTimeout: Seconds
  private inFlight = new Map<string, InFlight>()

  constructor(options: {
    registry: WidgetRegistry
    providers: ProviderRuntime[]
    cache?: ProviderSnapshotCache
    defaults?: Defaults
    now?: Clock
    providerRefreshTimeout?: Seconds
  }) {
    const defaults = options.defaults ?? standardDefaults()
    super(options.registry, defaults, options.now ?? Date.now)
    this.providerRefreshTimeout = options.providerRefreshTimeout ?? WidgetDataStore.defaultProviderRefreshTimeout
    if (!(this.providerRefreshTimeout > 0)) throw new Error('providerRefreshTimeout must be positive')
    for (const provider of options.providers) this.providersByID.set(provider.provider.id, provider)
    this.cache = options.cache ?? new ProviderSnapshotCache(defaults)
    const ids = new Set(options.registry.providers.map((provider) => provider.id))
    this.snapshotsByID = Object.fromEntries(Object.entries(this.cache.load()).filter(([id]) => ids.has(id)))
    this.latchBurningFast()
    for (const [id, snapshot] of Object.entries(this.snapshotsByID)) this.providersByID.get(id)?.restore(snapshot)
  }

  /** Replaces every snapshot (tests and sample data set readings directly). */
  setSnapshots(snapshots: Record<string, ProviderSnapshot>): void {
    this.snapshotsByID = snapshots
    this.latchBurningFast()
    this.notify()
  }

  setSnapshot(providerID: string, snapshot: ProviderSnapshot | undefined): void {
    const next = { ...this.snapshotsByID }
    if (snapshot) next[providerID] = snapshot
    else delete next[providerID]
    this.setSnapshots(next)
  }

  protected override settingsChanged(): void {
    // The latch depends on the display settings only through the readings, which have not changed.
    this.notify()
  }

  apply(providers: ProviderRuntime[], registry: WidgetRegistry): void {
    this.registry = registry
    this.providersByID = new Map(providers.map((provider) => [provider.provider.id, provider]))
    const ids = new Set(this.providersByID.keys())
    for (const id of [...this.inFlight.keys()]) if (!ids.has(id)) this.inFlight.delete(id)
    this.refreshingIDs = new Set(this.inFlight.keys())
    const next = Object.fromEntries(Object.entries(this.snapshotsByID).filter(([id]) => ids.has(id)))
    const removed = Object.keys(next).length < Object.keys(this.snapshotsByID).length
    this.snapshotsByID = next
    this.latchBurningFast()
    if (removed) this.cache.save(next)
    this.backoffsByID = Object.fromEntries(Object.entries(this.backoffsByID).filter(([id]) => ids.has(id)))
    this.notify()
  }

  async refreshAll(force = false): Promise<void> {
    await this.refreshPass(
      this.registry.providers.map((provider) => provider.id),
      force
    )
  }

  private async refreshPass(providerIDs: string[], force: boolean): Promise<void> {
    const start = performance.now()
    AppLog.notice('refresh', `batch start (${providerIDs.length} providers, force=${force})`)
    const outcomes = await this.refreshMany(providerIDs, force)
    this.lastRefreshAt = this.now()
    const durationMs = this.durationMilliseconds(start)
    const count = (outcome: RefreshOutcome): number => outcomes.filter((candidate) => candidate === outcome).length
    AppLog.notice(
      'refresh',
      `batch end (${durationMs}ms, ${count('refreshed')} ok / ${count('failed')} failed / ${count('cacheHit')} cached / ${count('backedOff')} backed off)`
    )
    this.notify()
  }

  /** `refresh(providerIDs:force:)`: the accounts fetch in parallel. */
  async refreshMany(providerIDs: string[], force: boolean): Promise<RefreshOutcome[]> {
    return Promise.all(providerIDs.map((providerID) => this.refresh(providerID, force, force)))
  }

  async refresh(providerID: string, force = false, rereadHourly = false): Promise<RefreshOutcome> {
    const shown = this.snapshotsByID[providerID]
    if (!force && shown) {
      const age = secondsBetween(this.now(), shown.refreshedAt)
      if (age >= 0 && age < RefreshSetting.interval) {
        AppLog.debug('refresh', `cache hit ${providerID}`)
        return 'cacheHit'
      }
    }
    if (!force) AppLog.debug('refresh', `cache miss ${providerID}`)

    const backoff = this.backoffsByID[providerID]
    if (backoff && RefreshBackoff.holds(backoff, this.now(), force)) {
      AppLog.debug('refresh', `backoff skip ${providerID} (${Math.trunc(secondsBetween(backoff.retryAt, this.now()))}s left)`)
      return 'backedOff'
    }

    const running = this.inFlight.get(providerID)
    if (running) {
      if (!force) {
        AppLog.debug('refresh', `cache skip ${providerID} (already in flight)`)
        return 'skipped'
      }
      const earlier = await running
      if (!earlier.ok && earlier.failure.kind.type === 'rateLimited') return 'backedOff'
      const next = this.inFlight.get(providerID)
      if (next && next !== running) return this.refresh(providerID, force, rereadHourly)
    }
    const provider = this.providersByID.get(providerID)
    if (!provider) return 'skipped'
    if (rereadHourly) provider.forgetHourlyReads()
    const start = performance.now()
    const timeout = this.providerRefreshTimeout
    const work: InFlight = (async (): Promise<RefreshResult> => {
      const result = await ProviderRefreshDeadline.run(timeout, () => provider.refresh())
      if (result === ProviderRefreshDeadline.timedOut) {
        return { ok: false, failure: { message: `Refresh timed out after ${Math.trunc(timeout)}s`, kind: { type: 'refused' } } }
      }
      return result
    })()
    this.inFlight.set(providerID, work)
    this.refreshingIDs = new Set(this.inFlight.keys())
    this.notify()
    let result: RefreshResult
    try {
      result = await work
    } finally {
      if (this.inFlight.get(providerID) === work) {
        this.inFlight.delete(providerID)
        this.refreshingIDs = new Set(this.inFlight.keys())
      }
    }
    if (this.providersByID.get(providerID) !== provider) {
      AppLog.debug('refresh', `dropped ${providerID} refresh; the account was removed`)
      this.notify()
      return 'skipped'
    }
    const durationMs = this.durationMilliseconds(start)
    if (durationMs >= WidgetDataStore.slowProviderRefreshThreshold * 1000) {
      AppLog.warn(
        'refresh',
        `${providerID} slow refresh (${durationMs}ms, threshold=${Math.trunc(WidgetDataStore.slowProviderRefreshThreshold * 1000)}ms)`
      )
    }
    if (!result.ok) return this.recordFailure(result.failure, providerID)
    this.store(result.snapshot, providerID)
    AppLog.info('refresh', `${providerID} ok (${durationMs}ms)`)
    return 'refreshed'
  }

  /** Redoes the reads a provider must not get in the same burst as usage, such as Claude's plan and reset grants. */
  async refreshHourlyReads(): Promise<void> {
    for (const id of this.registry.providers.map((provider) => provider.id)) {
      const provider = this.providersByID.get(id)
      const snapshot = this.snapshotsByID[id]
      const backoff = this.backoffsByID[id]
      if (!provider || this.inFlight.has(id) || !snapshot) continue
      if (backoff && RefreshBackoff.holds(backoff, this.now(), false)) continue
      const read = await ProviderRefreshDeadline.run(this.providerRefreshTimeout, () => provider.refreshHourlyReads(snapshot))
      if (read === ProviderRefreshDeadline.timedOut) {
        AppLog.warn('refresh', `${id} hourly reads timed out after ${Math.trunc(this.providerRefreshTimeout)}s`)
        continue
      }
      if (!read || this.providersByID.get(id) !== provider || this.snapshotsByID[id] !== snapshot) continue
      this.snapshotsByID = { ...this.snapshotsByID, [id]: read }
      this.latchBurningFast()
      this.cache.save(this.snapshotsByID)
      this.notify()
    }
  }

  private recordFailure(failure: RefreshFailure, providerID: string): RefreshOutcome {
    const backoff = RefreshBackoff.after(failure, this.backoffsByID[providerID], this.now())
    this.backoffsByID = { ...this.backoffsByID, [providerID]: backoff }
    const wait = Math.trunc(secondsBetween(backoff.retryAt, this.now()))
    AppLog.warn('refresh', `${providerID} failed: ${failure.message} Next try in ${wait}s.`)
    this.notify()
    return 'failed'
  }

  private durationMilliseconds(start: number): number {
    return Math.max(0, Math.trunc(performance.now() - start))
  }

  /**
   * Installs a validated key's runtime and snapshot together. Reads started by the previous
   * runtime can finish later, but the runtime identity check discards their results.
   */
  replaceProvider(provider: ProviderRuntime, snapshot: ProviderSnapshot): void {
    const id = provider.provider.id
    this.inFlight.delete(id)
    this.refreshingIDs = new Set(this.inFlight.keys())
    this.providersByID.set(id, provider)
    this.store(snapshot, id)
  }

  private store(snapshot: ProviderSnapshot, providerID: string): void {
    const backoffs = { ...this.backoffsByID }
    delete backoffs[providerID]
    this.backoffsByID = backoffs
    this.snapshotsByID = { ...this.snapshotsByID, [providerID]: snapshot }
    this.latchBurningFast()
    this.cache.save(this.snapshotsByID)
    this.notify()
  }
}
