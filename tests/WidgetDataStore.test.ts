import { describe, expect, it } from 'vitest'
import { Account, AccountCredential } from '@core/models/Account'
import { DashboardRowModel, type DashboardRowMark } from '@core/models/DashboardRowModel'
import { MetricLine, ProgressFormat } from '@core/models/MetricLine'
import { metricValue } from '@core/models/MetricValue'
import type { Provider } from '@core/models/Provider'
import { ProviderSnapshot } from '@core/models/ProviderSnapshot'
import { WidgetData } from '@core/models/WidgetData'
import { WidgetDescriptor } from '@core/models/WidgetDescriptor'
import { AccountProviderRuntime } from '@core/providers/AccountProviderRuntime'
import { widgetDescriptors } from '@core/providers/AccountProviderRuntime+Descriptors'
import { ClaudeUsageMapper } from '@core/providers/claude/ClaudeUsageMapper'
import { CodexUsageMapper } from '@core/providers/codex/CodexUsageMapper'
import { CursorUsageMapper } from '@core/providers/cursor/CursorUsageMapper'
import { HTTPResponse } from '@core/services/HTTPClient'
import { ProviderSnapshotCache } from '@core/stores/ProviderSnapshotCache'
import { HeldResponse, InMemoryCredentialVault, isolatedDefaults, RoutingHTTPClient, StubRuntime } from './TestSupport'
import { storeForTesting, SuspendedProviderRuntime, yieldTask } from './support/dataStoreHelpers'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** `.value(_:)` with Swift's defaults. */
function value(text: string): DashboardRowMark {
  return { type: 'value', text, detail: undefined, severity: 'normal' }
}

function makeRuntime(id: string): [Provider, StubRuntime] {
  const provider: Provider = { id, kind: 'codex' }
  return [
    provider,
    StubRuntime.snapshot(
      provider,
      [],
      ProviderSnapshot.make({
        providerID: provider.id,
        displayName: 'ChatGPT',
        lines: [MetricLine.progress('Session', 1, 100, ProgressFormat.percent)]
      })
    )
  ]
}

function emptySnapshot(provider: Provider): ProviderSnapshot {
  return ProviderSnapshot.forProvider(provider, undefined, [])
}

describe('WidgetDataStoreTests', () => {
  it('testForcedRefreshesWaitingOnOneReadTakeTurns', async () => {
    const account = Account.make({ kind: 'openrouter', label: 'Work' })
    const vault = new InMemoryCredentialVault()
    vault.save(AccountCredential.apiKey('key'), account.id)
    const firstRead = new HeldResponse()
    const active = { now: 0, most: 0 }
    const http = new RoutingHTTPClient(async () => {
      active.now += 1
      active.most = Math.max(active.most, active.now)
      await firstRead.hold()
      await sleep(20)
      active.now -= 1
      return new HTTPResponse(401)
    })
    const runtime = new AccountProviderRuntime(account, vault, http)
    const store = storeForTesting([runtime], { defaults: isolatedDefaults() })
    const id = runtime.provider.id

    const first = store.refresh(id)
    await firstRead.waitUntilHeld()
    const forced = [0, 1].map(() => store.refresh(id, true))
    await sleep(50)
    firstRead.release()
    let untracked = false
    for (let i = 0; i < 2000 && (http.requests.length < 3 || active.now > 0); i++) {
      if (active.now > 0 && !store.refreshingProviderIDs.has(id)) untracked = true
      await sleep(1)
    }
    await first
    await Promise.all(forced)

    expect(http.requests.length, 'three reads of one request each').toBe(3)
    expect(active.most, 'two reads of one account ran at once').toBe(1)
    expect(untracked, 'a read ran while the account was not marked refreshing').toBe(false)
  })

  it('testAForcedRefreshWaitingOnARead429HoldsUntilRetryAfter', async () => {
    const account = Account.make({ kind: 'openrouter', label: 'Work' })
    const vault = new InMemoryCredentialVault()
    vault.save(AccountCredential.apiKey('key'), account.id)
    const firstRead = new HeldResponse()
    const http = new RoutingHTTPClient(async () => {
      await firstRead.hold()
      return new HTTPResponse(429, { 'retry-after': '600' })
    })
    const runtime = new AccountProviderRuntime(account, vault, http)
    const store = storeForTesting([runtime], { defaults: isolatedDefaults() })
    const id = runtime.provider.id

    const first = store.refresh(id)
    await firstRead.waitUntilHeld()
    const forced = store.refresh(id, true)
    await sleep(50)
    firstRead.release()
    await first

    const outcome = await forced
    expect(outcome).toBe('backedOff')
    expect(http.requests.length, "the waiting refresh asked again inside the provider's wait").toBe(1)
  })

  it('testAFinishedAccountShowsAndPersistsWithoutWaitingForThePass', async () => {
    const fast = makeRuntime('fast')
    const slowProvider: Provider = { id: 'slow', kind: 'codex' }
    const slow = new SuspendedProviderRuntime(slowProvider, emptySnapshot(slowProvider))
    const defaults = isolatedDefaults()
    const store = storeForTesting([fast[1], slow], { defaults })
    const refreshTask = store.refreshAll()

    for (let i = 0; i < 1_000 && !slow.didStart; i++) await yieldTask()
    for (let i = 0; i < 1_000 && store.snapshots[fast[0].id] === undefined; i++) await yieldTask()
    expect(slow.didStart).toBe(true)
    expect(store.snapshots[fast[0].id], 'a finished account shows without waiting for the pass').toBeDefined()
    expect(new ProviderSnapshotCache(defaults, 'snapshots').load()[fast[0].id], 'and its snapshot is on disk').toBeDefined()

    slow.complete()
    await refreshTask
  })

  it('testRefreshingSeveralAccountsStartsThemAllBeforeAnyFinishes', async () => {
    const providers: Provider[] = ['first', 'second'].map((id) => ({ id, kind: 'codex' }))
    const runtimes = providers.map((provider) => new SuspendedProviderRuntime(provider, emptySnapshot(provider)))
    const defaults = isolatedDefaults()
    const store = storeForTesting(runtimes, { defaults })

    const refreshTask = store.refreshMany(
      providers.map((provider) => provider.id),
      true
    )
    for (let i = 0; i < 1_000 && runtimes.some((runtime) => !runtime.didStart); i++) await yieldTask()

    expect(
      runtimes.every((runtime) => runtime.didStart),
      'both accounts are in flight before either completes'
    ).toBe(true)
    expect(store.refreshingProviderIDs).toEqual(new Set(['first', 'second']))

    for (const runtime of runtimes) runtime.complete()
    const outcomes = await refreshTask
    expect(outcomes).toEqual(['refreshed', 'refreshed'])
    expect(store.refreshingProviderIDs.size).toBe(0)
  })

  it('testBarFractionMatchesRoundedValue', () => {
    const cases: [number, string, number][] = [
      [0.3915, '0%', 0.0],
      [0.6, '1%', 0.01],
      [99.6, '100%', 1.0]
    ]
    for (const [used, valueText, fraction] of cases) {
      const data = new WidgetData({ title: 'Total usage', kind: 'percent', used, limit: 100 })
      expect(data.valueText).toBe(valueText)
      expect(data.fraction).toBeCloseTo(fraction, 4)
    }
  })

  it('testCreditsRenderProviderReportedCountInvariantToMeterStyle', async () => {
    const provider: Provider = { id: 'codex', kind: 'codex' }
    const descriptor = WidgetDescriptor.values({ key: 'credits', provider, title: 'Extra Usage', metricLabel: 'Credits' })
    const runtime = StubRuntime.snapshot(
      provider,
      [descriptor],
      ProviderSnapshot.forProvider(provider, undefined, [MetricLine.values('Credits', CodexUsageMapper.creditValues(1000))])
    )
    const defaults = isolatedDefaults()
    const store = storeForTesting([runtime], { defaults })
    await store.refreshAll()

    store.meterStyle = 'remaining'
    const remaining = store.data(descriptor)
    expect(remaining.isBounded).toBe(false)
    expect(remaining.unboundedDetail).toBe('$40')
    expect(DashboardRowModel.make(remaining).mark).toEqual(value('$40'))

    store.meterStyle = 'used'
    const used = store.data(descriptor)
    expect(used.unboundedDetail).toBe(remaining.unboundedDetail)
    expect(DashboardRowModel.make(used)).toEqual(DashboardRowModel.make(remaining))
  })

  it('testRateLimitResetsShowsAvailableCountInDashboard', async () => {
    const provider: Provider = { id: 'codex', kind: 'codex' }
    const descriptor = WidgetDescriptor.values({
      key: 'rateLimitResets',
      provider,
      title: 'Rate Limit Resets',
      metricLabel: 'Rate Limit Resets'
    })
    const runtime = StubRuntime.snapshot(
      provider,
      [descriptor],
      ProviderSnapshot.forProvider(provider, undefined, [MetricLine.values('Rate Limit Resets', [metricValue(1, 'count', 'available')])])
    )
    const defaults = isolatedDefaults()
    const store = storeForTesting([runtime], { defaults })
    await store.refreshAll()

    const data = store.data(descriptor)
    expect(data.hasData).toBe(true)
    expect(data.isBounded).toBe(false)
    expect(data.unboundedDetail).toBe('1 available')
    expect(DashboardRowModel.make(data).mark).toEqual(value('1 available'))
  })

  it('testZeroRateLimitResetsStillFlagsResetPopoverForEmptyState', async () => {
    const provider: Provider = { id: 'codex', kind: 'codex' }
    const descriptor = WidgetDescriptor.values({
      key: 'rateLimitResets',
      provider,
      title: 'Rate Limit Resets',
      metricLabel: 'Rate Limit Resets',
      showsResetExpiries: true
    })
    const runtime = StubRuntime.snapshot(
      provider,
      [descriptor],
      ProviderSnapshot.forProvider(provider, undefined, [MetricLine.values('Rate Limit Resets', [metricValue(0, 'count', 'available')])])
    )
    const defaults = isolatedDefaults()
    const store = storeForTesting([runtime], { defaults })
    await store.refreshAll()

    const data = store.data(descriptor)
    expect(data.showsResetExpiries).toBe(true)
    expect(data.hasData).toBe(true)
    expect(data.expiriesAt).toEqual([])
    expect(data.resetCreditCount).toBe(0)
    expect(data.unboundedDetail).toBe('0 available')
  })

  it('testBoundedDollarAndCountTrayValuesHonorMeterStyleWithoutPercentConversion', async () => {
    const provider: Provider = { id: 'example', kind: 'cursor' }
    const budget = WidgetDescriptor.boundedDollars({ key: 'budget', provider, title: 'Budget', limit: 100 })
    const requests = WidgetDescriptor.boundedCount({
      key: 'requests',
      provider,
      title: 'Requests',
      limit: 500,
      periodDurationMs: CursorUsageMapper.billingPeriodMs
    })
    const runtime = StubRuntime.snapshot(
      provider,
      [budget, requests],
      ProviderSnapshot.forProvider(provider, undefined, [
        MetricLine.progress('Budget', 12.48, 20, ProgressFormat.dollars),
        MetricLine.progress('Requests', 412, 500, ProgressFormat.count('requests'))
      ])
    )
    const defaults = isolatedDefaults()
    const store = storeForTesting([runtime], { defaults })
    await store.refreshAll()

    store.meterStyle = 'used'
    expect(store.data(budget).menuBarValue).toBe('$12')
    expect(store.data(requests).menuBarValue).toBe('412')

    store.meterStyle = 'remaining'
    expect(store.data(budget).menuBarValue).toBe('$8')
    expect(store.data(requests).menuBarValue).toBe('88')
  })

  it('testCursorCreditsRenderAsUnboundedBalance', async () => {
    const provider: Provider = { id: 'cursor', kind: 'cursor' }
    const descriptor = WidgetDescriptor.values({ key: 'credits', provider, title: 'Credits', valueWord: 'left' })
    const runtime = StubRuntime.snapshot(
      provider,
      [descriptor],
      ProviderSnapshot.forProvider(provider, undefined, [MetricLine.values('Credits', [metricValue(7_909.64, 'dollars')])])
    )
    const defaults = isolatedDefaults()
    const store = storeForTesting([runtime], { defaults })
    await store.refreshAll()

    store.meterStyle = 'remaining'
    const remaining = store.data(descriptor)
    expect(remaining.isBounded).toBe(false)
    expect(remaining.unboundedDetail).toBe('$7.9K left')

    store.meterStyle = 'used'
    const used = store.data(descriptor)
    expect(used.unboundedDetail).toBe(remaining.unboundedDetail)
  })

  it('testClaudesUncappedExtraUsageReadsCompactDollarsSpent', async () => {
    const account = Account.make({ kind: 'claude', label: 'Max' })
    const descriptor = widgetDescriptors(account).find((candidate) => candidate.key === 'extra')
    if (!descriptor) throw new Error('no extra descriptor')
    const lines = ClaudeUsageMapper.mapUsageResponse(
      new HTTPResponse(200, {}, '{"extra_usage":{"is_enabled":true,"used_credits":123456,"monthly_limit":null}}')
    )
    const provider = AccountProviderRuntime.provider(account)
    const runtime = StubRuntime.snapshot(provider, [descriptor], ProviderSnapshot.forProvider(provider, undefined, lines))
    const store = storeForTesting([runtime], { defaults: isolatedDefaults() })
    await store.refreshAll()

    const data = store.data(descriptor)
    expect(DashboardRowModel.make(data)).toEqual({ label: 'Extra Usage', mark: value('$1.2K spent'), showsClockTimes: false })
  })

  it('testClaudesExtraUsageReadsInTheBillingCurrency', async () => {
    const account = Account.make({ kind: 'claude', label: 'Team' })
    const descriptor = widgetDescriptors(account).find((candidate) => candidate.key === 'extra')
    if (!descriptor) throw new Error('no extra descriptor')
    const provider = AccountProviderRuntime.provider(account)
    async function data(extra: string): Promise<WidgetData> {
      const lines = ClaudeUsageMapper.mapUsageResponse(new HTTPResponse(200, {}, `{"extra_usage":${extra}}`))
      const runtime = StubRuntime.snapshot(provider, [descriptor!], ProviderSnapshot.forProvider(provider, undefined, lines))
      const store = storeForTesting([runtime], { defaults: isolatedDefaults() })
      store.meterStyle = 'used'
      await store.refreshAll()
      return store.data(descriptor!)
    }

    const capped = await data('{"is_enabled":true,"used_credits":1234,"monthly_limit":5000,"currency":"EUR","decimal_places":2}')
    expect(DashboardRowModel.amountText(capped)).toBe('€12.34 used')
    expect(DashboardRowModel.meterStyleTooltip(capped)).toBe('€37.66 left')
    expect(capped.menuBarValue).toBe('€12')

    const uncapped = await data('{"is_enabled":true,"used_credits":1500,"monthly_limit":null,"currency":"JPY","decimal_places":0}')
    expect(DashboardRowModel.make(uncapped)).toEqual({ label: 'Extra Usage', mark: value('¥1.5K spent'), showsClockTimes: false })
  })

  it('testAClaudeAccountWithNoFiveHourWindowHasNoSessionRow', async () => {
    const account = Account.make({ kind: 'claude', label: 'Ultra' })
    const descriptors = widgetDescriptors(account)
    const session = descriptors.find((candidate) => candidate.key === 'session')
    const weekly = descriptors.find((candidate) => candidate.key === 'weekly')
    if (!session || !weekly) throw new Error('missing descriptors')
    const provider = AccountProviderRuntime.provider(account)
    for (const body of [
      '{"five_hour":null,"seven_day":{"utilization":40,"resets_at":"2099-01-01T00:00:00.000Z"}}',
      '{"seven_day":{"utilization":40,"resets_at":"2099-01-01T00:00:00.000Z"}}'
    ]) {
      const lines = ClaudeUsageMapper.mapUsageResponse(new HTTPResponse(200, {}, body))
      const runtime = StubRuntime.snapshot(provider, [session, weekly], ProviderSnapshot.forProvider(provider, 'Ultra', lines))
      const store = storeForTesting([runtime], { defaults: isolatedDefaults() })
      await store.refreshAll()

      expect(store.data(session).hasData, body).toBe(false)
      expect(store.data(weekly).hasData, body).toBe(true)
    }
  })

  it('testCreditValuesFloorAndClampBalance', () => {
    const data = new WidgetData({ title: 'Extra Usage', kind: 'dollars', used: 0, limit: undefined })
    data.values = CodexUsageMapper.creditValues(821.6)
    expect(data.unboundedDetail).toBe('$32.84')
    data.values = CodexUsageMapper.creditValues(-5)
    expect(data.unboundedDetail).toBe('$0')
  })
})
