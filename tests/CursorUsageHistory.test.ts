import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Account, AccountCredential, OAuthTokens } from '@core/models/Account'
import { HistoryRow } from '@core/models/HistoryRow'
import { ProviderSnapshot } from '@core/models/ProviderSnapshot'
import { UsageBreakdown, UsageHistory, UsageTotals, UsageWindow, type UsageDay } from '@core/models/UsageHistory'
import type { WidgetDescriptor } from '@core/models/WidgetDescriptor'
import { AccountProviderRuntime } from '@core/providers/AccountProviderRuntime'
import type { ProviderRuntime } from '@core/providers/ProviderRuntime'
import { UsageLedger } from '@core/providers/UsageLedger'
import { CursorHistorySource } from '@core/providers/cursor/CursorHistorySource'
import { CursorUsageClient } from '@core/providers/cursor/CursorUsageClient'
import { CursorUsageEvents } from '@core/providers/cursor/CursorUsageEvents'
import { HTTPResponse, type HTTPRequest } from '@core/services/HTTPClient'
import { ProviderSnapshotCache } from '@core/stores/ProviderSnapshotCache'
import { WidgetDataStore } from '@core/stores/WidgetDataStore'
import { WidgetRegistry } from '@core/stores/WidgetRegistry'
import { Calendar } from '@core/support/Calendar'
import type { Defaults } from '@core/support/Defaults'
import { asString, ProviderParse, type JSONObject } from '@core/support/ProviderParse'
import { addSeconds, type Clock, type Instant } from '@core/support/time'
import { InMemoryCredentialVault, isolatedDefaults, RoutingHTTPClient, TestClock, TestSwitch, unix } from './TestSupport'

/** A JWT whose subject carries the user id the cursor.com cookie endpoints need. */
const accessToken = 'e30.' + Buffer.from('{"sub":"auth0|user_fake"}', 'utf8').toString('base64').replaceAll('=', '') + '.sig'
const now = unix(1_793_000_000)

const pathOf = (url: string): string => new URL(url).pathname

function requestBody(request: HTTPRequest): JSONObject | undefined {
  return request.body === undefined ? undefined : ProviderParse.jsonObject(request.body)
}

/** `Int(string)`: undefined for anything but a whole number. */
function int(text: string | undefined): number | undefined {
  return text !== undefined && /^[+-]?\d+$/.test(text) ? Number(text) : undefined
}

function expectClose(actual: number, expected: number, accuracy: number, message?: string): void {
  expect(Math.abs(actual - expected), message).toBeLessThanOrEqual(accuracy)
}

/** `WidgetDataStore.forTesting(_:defaults:now:)` */
function storeForTesting(runtimes: ProviderRuntime[], defaults: Defaults, now: Clock): WidgetDataStore {
  return new WidgetDataStore({
    registry: WidgetRegistry.from(runtimes),
    providers: runtimes,
    cache: new ProviderSnapshotCache(defaults, 'snapshots'),
    defaults,
    now
  })
}

describe('CursorUsageEventsParserTests', () => {
  /**
   * Shaped like Cursor's `get-filtered-usage-events` page: on-demand events carry what Cursor charged,
   * and included events carry the value taken from the plan in the same field.
   */
  const mixedPage = `{"totalUsageEventsCount":7,"usageEventsDisplay":[
 {"timestamp":"1793000000000","model":"claude-4.6-opus-high-thinking","kind":"USAGE_EVENT_KIND_USAGE_BASED",
  "requestsCosts":30.4,"usageBasedCosts":"$1.25","isTokenBasedCall":true,
  "tokenUsage":{"inputTokens":3,"outputTokens":20525,"cacheWriteTokens":112151,"totalCents":121.41},
  "cursorTokenFee":3.32,"isChargeable":true,"isHeadless":false,"chargedCents":124.73},
 {"timestamp":"1793000001000","model":"composer-2","kind":"USAGE_EVENT_KIND_INCLUDED_IN_PRO",
  "usageBasedCosts":"-","tokenUsage":{"inputTokens":3438,"outputTokens":76,"totalCents":40},
  "isChargeable":false,"chargedCents":40},
 {"timestamp":"1793000002000","model":"gpt-5","kind":"USAGE_EVENT_KIND_USAGE_BASED","isChargeable":false,"chargedCents":50},
 {"timestamp":"1793000003000","model":"gpt-5","kind":"USAGE_EVENT_KIND_ERRORED_NOT_CHARGED"},
 {"timestamp":"1793000003500","model":"composer-2","kind":"USAGE_EVENT_KIND_FREE_CREDIT","isChargeable":false,"chargedCents":40},
 {"timestamp":1793000004000,"model":"composer-2","kind":"USAGE_EVENT_KIND_USAGE_BASED","chargedCents":"3.5"},
 {"timestamp":"1793000005000","model":"composer-2","kind":"USAGE_EVENT_KIND_USAGE_BASED","isChargeable":true}
]}`

  it('testOnlyOnDemandEventsCountWhatCursorCharged', () => {
    const page = CursorUsageEvents.parsePage(mixedPage)
    if (!page) throw new Error('expected a page')

    expect(page.totalCount).toBe(7)
    expect(page.events.map((event) => event.totals.values.spend)).toEqual([124.73, 0, 0, 0, 0, 3.5, 0].map((cents) => cents / 100))
    expect(page.events[0]?.date).toBe(unix(1_793_000_000))
    expect(page.events.at(-1)?.date).toBe(unix(1_793_000_005))
  })

  it('testTokensAreEveryKindCursorReportedOnAnyEventKindAndZeroWithoutTokenUsage', () => {
    const page = CursorUsageEvents.parsePage(mixedPage)
    if (!page) throw new Error('expected a page')

    expect(page.events.map((event) => event.totals.values.tokens)).toEqual([132_679, 3_514, 0, 0, 0, 0, 0])
    expect(page.events[0].totals.values).toEqual({
      spend: 124.73 / 100,
      usageEvents: 1,
      tokens: 132_679,
      inputTokens: 3,
      cacheReadTokens: 0,
      cacheWriteTokens: 112_151,
      outputTokens: 20_525
    })
    expect(page.events.map((event) => event.model)).toEqual([
      'claude-4.6-opus-high-thinking',
      'composer-2',
      'gpt-5',
      'gpt-5',
      'composer-2',
      'composer-2',
      'composer-2'
    ])

    const events = page.events.map((event) => ({ ...event }))
    delete events[0].model
    const day = CursorUsageEvents.day(events)
    // an unnamed event preserves the named model totals
    expect(day.byModel?.['composer-2']?.values.tokens).toBe(3_514)
    // the total includes the event with no model name
    expect(day.totals.values.tokens).toBe(136_193)
    expect(day.totals.values.usageEvents).toBe(7)
    // a quiet day is zeros, not a gap
    expect(CursorUsageEvents.day([]).totals).toEqual(UsageTotals.zero(CursorUsageEvents.measures))
  })

  it('testAnEmptyPageLeavesOutItsEventListButNotItsCount', () => {
    expect(CursorUsageEvents.parsePage('{"totalUsageEventsCount":0}')?.events).toEqual([])
    for (const body of [
      '{"error":"unauthorized"}',
      '{"usageEventsDisplay":[]}',
      '{"totalUsageEventsCount":1,"usageEventsDisplay":[{"kind":"USAGE_EVENT_KIND_USAGE_BASED","chargedCents":5}]}',
      '{"totalUsageEventsCount":1,"usageEventsDisplay":[{"timestamp":"1","kind":"USAGE_EVENT_KIND_USAGE_BASED","chargedCents":-5}]}',
      '{"totalUsageEventsCount":1,"usageEventsDisplay":[{"timestamp":"1","kind":"USAGE_EVENT_KIND_USAGE_BASED","chargedCents":"$0.05"}]}',
      '{"totalUsageEventsCount":1,"usageEventsDisplay":[{"timestamp":"1","tokenUsage":{"inputTokens":-1}}]}',
      '{"totalUsageEventsCount":1,"usageEventsDisplay":[{"timestamp":"1","tokenUsage":"lots"}]}'
    ]) {
      expect(CursorUsageEvents.parsePage(body), body).toBeUndefined()
    }
  })
})

describe('CursorUsageHistoryTests', () => {
  const usage = `{"autoBucketModels":["fake-model"],"billingCycleEnd":"1764547200000","billingCycleStart":"1761955200000","enabled":true,
 "planUsage":{"apiPercentUsed":40,"autoPercentUsed":20,"limit":40000,"remaining":30000,"totalPercentUsed":25},
 "spendLimitUsage":{"individualLimit":50000,"individualRemaining":38000,"limitType":"user"}}`
  const planInfo = '{"planInfo":{"planName":"Ultra"}}'

  /**
   * Every day holds one on-demand event Cursor charged $1.25 for and one included event worth $9.99 of
   * plan usage, so only the charge counts.
   */
  function eventsPage(request: HTTPRequest): HTTPResponse {
    const body = requestBody(request)
    const start = int(asString(body?.startDate))
    const end = int(asString(body?.endDate))
    if (!body || start === undefined || end === undefined || body.page !== 1) return new HTTPResponse(400, {}, new Uint8Array())
    const timestamp = Math.min(start + 3_600_000, end)
    const page = `{"totalUsageEventsCount":2,"usageEventsDisplay":[
 {"timestamp":"${timestamp}","model":"claude-4.6-opus","kind":"USAGE_EVENT_KIND_USAGE_BASED","isChargeable":true,
  "chargedCents":125,"tokenUsage":{"inputTokens":3,"outputTokens":200,"totalCents":120}},
 {"timestamp":"${timestamp}","model":"composer-2","kind":"USAGE_EVENT_KIND_INCLUDED_IN_PRO","isChargeable":false,
  "chargedCents":999,"tokenUsage":{"inputTokens":3000,"outputTokens":100,"totalCents":999}}]}`
    return new HTTPResponse(200, {}, page)
  }

  function makeAccount(
    events: TestSwitch<number | undefined>,
    retryAfter?: string,
    clock: TestClock = new TestClock(now)
  ): { store: WidgetDataStore; runtime: AccountProviderRuntime; http: RoutingHTTPClient } {
    const account = Account.make({ kind: 'cursor', label: 'Cursor' })
    const vault = new InMemoryCredentialVault()
    vault.save(AccountCredential.oauth(OAuthTokens.make(accessToken, 'refresh')), account.id)
    const http = new RoutingHTTPClient((request) => {
      switch (pathOf(request.url)) {
        case pathOf(CursorUsageClient.usageURL):
          return new HTTPResponse(200, {}, usage)
        case pathOf(CursorUsageClient.planURL):
          return new HTTPResponse(200, {}, planInfo)
        case pathOf(CursorUsageClient.usageEventsURL): {
          const status = events.value
          if (status !== undefined) {
            if (status === 429) clock.set(addSeconds(clock.now(), 15))
            return new HTTPResponse(status, retryAfter === undefined ? {} : { 'retry-after': retryAfter }, new Uint8Array())
          }
          return eventsPage(request)
        }
        default:
          return new HTTPResponse(404, {}, new Uint8Array())
      }
    })
    const runtime = new AccountProviderRuntime(account, vault, http, clock.now)
    return { store: storeForTesting([runtime], isolatedDefaults(), clock.now), runtime, http }
  }

  function spend(store: WidgetDataStore, runtime: AccountProviderRuntime): Record<string, number | undefined> {
    const spend: Record<string, number | undefined> = {}
    for (const descriptor of runtime.widgetDescriptors) {
      if (!['today', 'yesterday', 'last30'].includes(descriptor.key)) continue
      const widget = store.data(descriptor)
      if (widget.hasData) spend[widget.title] = widget.values[0]?.number
    }
    return spend
  }

  function eventRequests(http: RoutingHTTPClient): HTTPRequest[] {
    return http.requests.filter((request) => request.url === CursorUsageClient.usageEventsURL)
  }

  it('testTheRowsShowWhatCursorChargedForOnDemandUsageAndNoEstimate', async () => {
    const { store, runtime, http } = makeAccount(new TestSwitch<number | undefined>(undefined))

    await store.refresh(runtime.provider.id, true)

    expect(store.errorMessage(runtime.provider.id)).toBeUndefined()
    expect(spend(store, runtime)).toEqual({ Today: 1.25, Yesterday: 1.25, 'Last 30 Days': 37.5 })
    const requests = eventRequests(http)
    // one page for each of the 30 days
    expect(requests.length).toBe(30)
    const request = requests[0]
    expect(request).toBeDefined()
    expect(request.method).toBe('POST')
    expect(request.headers?.Cookie).toBe(`WorkosCursorSessionToken=user_fake%3A%3A${accessToken}`)
    expect(request.headers?.Origin).toBe('https://cursor.com')
  })

  it('testALaterRefreshRereadsOnlyTodayAndYesterday', async () => {
    const { store, runtime, http } = makeAccount(new TestSwitch<number | undefined>(undefined))
    await store.refresh(runtime.provider.id, true)
    const firstRead = eventRequests(http).length

    await store.refresh(runtime.provider.id, true)

    expect(eventRequests(http).length - firstRead).toBe(2)
    expect(spend(store, runtime)).toEqual({ Today: 1.25, Yesterday: 1.25, 'Last 30 Days': 37.5 })
  })

  it('testAFailedRereadDropsUnreadDaysButKeepsEarlierDaysInTheRange', async () => {
    const events = new TestSwitch<number | undefined>(500)
    const { store, runtime } = makeAccount(events)

    await store.refresh(runtime.provider.id, true)
    expect(store.errorMessage(runtime.provider.id)).toBeUndefined()
    // nothing read yet, so every range reads $0
    expect(spend(store, runtime)).toEqual({ Today: 0, Yesterday: 0, 'Last 30 Days': 0 })
    const totalUsage = runtime.widgetDescriptors.find((descriptor) => descriptor.key === 'usage')
    if (!totalUsage) throw new Error('expected the usage descriptor')
    expect(store.data(totalUsage).used).toBe(25)

    events.value = undefined
    await store.refresh(runtime.provider.id, true)
    events.value = 503
    await store.refresh(runtime.provider.id, true)

    expect(store.errorMessage(runtime.provider.id)).toBeUndefined()
    // 28 complete days at $1.25 after today and yesterday failed
    expect(spend(store, runtime)).toEqual({ Today: 0, Yesterday: 0, 'Last 30 Days': 35 })
  })

  /** Each rate-limited request takes 15 seconds, so the wait has to start when the 429 arrives. */
  it('testARateLimitStopsTheSweepAndWaitsForRetryAfterOrAnHour', async () => {
    const cases: { retryAfter: string | undefined; wait: number }[] = [
      { retryAfter: '120', wait: 120.0 },
      { retryAfter: undefined, wait: 3600.0 }
    ]
    for (const { retryAfter, wait } of cases) {
      const events = new TestSwitch<number | undefined>(429)
      const clock = new TestClock(now)
      const { store, runtime, http } = makeAccount(events, retryAfter, clock)

      await store.refresh(runtime.provider.id, true)
      const firstSweep = eventRequests(http).length
      // the sweep stops at the 429 instead of asking for all 30 days
      expect(firstSweep).toBeLessThanOrEqual(4)
      const answered = clock.now()

      events.value = undefined
      clock.set(addSeconds(answered, wait - 1))
      await store.refresh(runtime.provider.id, true)
      // no history read before the wait ends
      expect(eventRequests(http).length).toBe(firstSweep)
      expect(spend(store, runtime)).toEqual({ Today: 0, Yesterday: 0, 'Last 30 Days': 0 })

      clock.set(addSeconds(answered, wait + 1))
      await store.refresh(runtime.provider.id, true)
      // every unread day is still due
      expect(eventRequests(http).length - firstSweep).toBe(30)
      expect(spend(store, runtime)).toEqual({ Today: 1.25, Yesterday: 1.25, 'Last 30 Days': 37.5 })
    }
  })

  it('testTheRowsAddTheTokensCursorReported', async () => {
    const { store, runtime } = makeAccount(new TestSwitch<number | undefined>(undefined))

    await store.refresh(runtime.provider.id, true)

    const rows: Record<string, string> = {}
    for (const descriptor of runtime.widgetDescriptors) {
      if (descriptor.historyRow === undefined) continue
      const data = store.data(descriptor)
      if (data.hasData) rows[descriptor.key] = data.unboundedDetail
    }
    expect(rows).toEqual({
      today: '$1.25 · 3.3K tokens',
      yesterday: '$1.25 · 3.3K tokens',
      last30: '$37.50 · 99.1K tokens'
    })
  })

  it('testEachWindowRowHasABreakdownOfWhatCursorReported', async () => {
    const { store, runtime } = makeAccount(new TestSwitch<number | undefined>(undefined))
    const descriptor = (key: string): WidgetDescriptor => {
      const found = runtime.widgetDescriptors.find((descriptor) => descriptor.key === key)
      if (!found) throw new Error(`no ${key} descriptor`)
      return found
    }
    // nothing read yet
    expect(store.usageBreakdown(descriptor('today'))).toBeUndefined()

    await store.refresh(runtime.provider.id, true)

    const today = store.usageBreakdown(descriptor('today'))
    if (!today) throw new Error('expected a breakdown for today')
    expect(today.window).toEqual(UsageWindow.today)
    expect(today.totals.values).toEqual({
      spend: 1.25,
      usageEvents: 2,
      tokens: 3_303,
      inputTokens: 3_003,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 300
    })
    // The ranking shown when the user has no saved figure preference.
    const figure = UsageBreakdown.modelFigures(today)[0]
    const models = figure === undefined ? [] : UsageBreakdown.models(today, figure)
    expect(models.map((model) => model.name)).toEqual(['claude-4.6-opus', 'composer-2'])
    expect(models.map((model) => model.dollars)).toEqual([1.25, 0])
    expect(models.map((model) => model.tokens)).toEqual([203, 3_100])
    expect(UsageBreakdown.modelFigures(today)).toEqual(['cost', 'tokens'])
    expect(store.usageBreakdown(descriptor('last30'))?.totals.values.usageEvents).toBe(60)
    expect(store.usageBreakdown(descriptor('yesterday'))).toBeDefined()
  })
})

describe('CursorHistorySourceTests', () => {
  // Upstream builds a Gregorian calendar in Asia/Dubai; the port's `Calendar` follows the process's
  // zone, so the zone is set for these tests and put back after them.
  const savedZone = process.env.TZ
  const setZone = (zone: string | undefined): void => {
    if (zone === undefined) delete process.env.TZ
    else process.env.TZ = zone
  }
  beforeAll(() => setZone('Asia/Dubai'))
  afterEach(() => setZone('Asia/Dubai'))
  afterAll(() => setZone(savedZone))

  const calendar = new Calendar('local')
  const span = (): Instant[] => UsageHistory.dayStartsBack(30, now, calendar)

  function source(http: RoutingHTTPClient): CursorHistorySource {
    return new CursorHistorySource(new CursorUsageClient(http), accessToken, 'cursor@1')
  }

  function page(request: HTTPRequest): { start: number; page: number } {
    const body = requestBody(request) ?? {}
    return { start: int(asString(body.startDate)) ?? 0, page: typeof body.page === 'number' ? body.page : 0 }
  }

  function events(total: number, milliseconds: number, cents: number[]): HTTPResponse {
    const events = cents.map((charged) => `{"timestamp":"${milliseconds}","kind":"USAGE_EVENT_KIND_USAGE_BASED","chargedCents":${charged}}`)
    const body = `{"totalUsageEventsCount":${total},"usageEventsDisplay":[${events.join(',')}]}`
    return new HTTPResponse(200, {}, body)
  }

  it('testADayOverSeveralPagesCountsEveryPageAndAShortPageFailsTheDay', async () => {
    const days30 = span()
    const short = days30[2]
    const http = new RoutingHTTPClient((request) => {
      const { start, page: number } = page(request)
      if (start === short) return events(3, start + 1, number === 1 ? [100, 100] : [])
      return events(3, start + 1, number === 1 ? [100, 100] : [25.5])
    })
    const history30 = source(http)
    history30.pageSize = 2

    const days = (await history30.read(days30, now, calendar)).days

    expect(days.size).toBe(29)
    // a page that ends before the count leaves the day unread
    expect(days.get(days30[2])).toBeUndefined()
    expectClose(days.get(days30[0])?.totals.values.spend ?? 0, 2.255, 1e-9)
    expectClose(days.get(days30[1])?.totals.values.spend ?? 0, 2.255, 1e-9)
    const history = UsageHistory.make(calendar, now, days)
    const cursor = new AccountProviderRuntime(
      Account.make({ kind: 'cursor', label: 'Cursor' }),
      new InMemoryCredentialVault(),
      new RoutingHTTPClient(() => new HTTPResponse(404, {}, new Uint8Array()))
    )
    const snapshot = ProviderSnapshot.forProvider(cursor.provider, undefined, [])
    HistoryRow.append(snapshot, cursor.widgetDescriptors, history)
    expect(snapshot.lines.map((line) => line.label)).toEqual(['Today', 'Yesterday', 'Last 30 Days'])
    const totals = snapshot.usageBreakdowns?.last30?.totals
    expectClose(totals?.values.spend ?? 0, 65.395, 1e-9, 'only the 29 complete days at $2.255 count')
    // the two events on the incomplete day are never added
    expect(totals?.values.usageEvents).toBe(87)
  })

  it('testTheTimeBudgetKeepsTheDaysThatFinished', async () => {
    const days30 = span()
    const today = days30[0]
    const http = new RoutingHTTPClient(async (request) => {
      const { start } = page(request)
      if (start !== today) await new Promise<void>((resolve) => setTimeout(resolve, 30_000).unref())
      return events(1, start + 1, [7])
    })
    const budgeted = source(http)
    budgeted.budget = 0.5
    const ledger = new UsageLedger()
    ledger.record(new Map<Instant, UsageDay>([[days30[9], { totals: UsageTotals.make({ spend: 0.03 }) }]]), [days30[9]], days30)

    const due = ledger.due(days30)
    ledger.record((await budgeted.read(due, now, calendar)).days, due, days30)

    // a day read before is not read again
    expect(due.length).toBe(29)
    expect(new Map([...ledger.days].map(([day, value]) => [day, value.totals.values.spend]))).toEqual(
      new Map([
        [days30[0], 0.07],
        [days30[9], 0.03]
      ])
    )
  })

  it('testADayThatStartsAtOneOClockIsReadToTheNextMidnight', async () => {
    setZone('America/Santiago')
    const santiago = new Calendar('local')
    const september6 = unix(1_788_667_200)
    const http = new RoutingHTTPClient(() => events(0, 0, []))

    const days = (await source(http).read([september6], unix(1_788_793_200), santiago)).days

    expect(days.get(september6)).toBeDefined()
    const first = http.requests[0]
    const body = first === undefined ? undefined : requestBody(first)
    expect(body).toBeDefined()
    // a 23-hour day ends at Sep 7 00:00, not 01:00
    expect(asString(body?.endDate)).toBe('1788749999999')
  })

  it('testADayLastReadWhileItWasTodayIsReadAgainAfterAGapOfDays', () => {
    const friday = span()
    const monday = UsageHistory.dayStartsBack(30, addSeconds(now, 3 * 86_400), calendar)
    const partial: UsageDay = { totals: UsageTotals.make({ spend: 1 }) }
    const full: UsageDay = { totals: UsageTotals.make({ spend: 4 }) }
    const ledger = new UsageLedger()
    ledger.record(
      new Map([
        [friday[0], partial],
        [friday[1], full]
      ]),
      ledger.due(friday),
      friday
    )

    const due = ledger.due(monday)

    // Friday was read before it ended
    expect(due.includes(friday[0])).toBe(true)
    // Thursday was read after it ended
    expect(due.includes(friday[1])).toBe(false)
    ledger.record(new Map([[friday[0], full]]), [friday[0]], monday)
    expect(ledger.days.get(friday[0])).toEqual(full)
    expect(ledger.due(monday).includes(friday[0])).toBe(false)
  })
})
