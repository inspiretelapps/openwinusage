import { describe, expect, it } from 'vitest'
import { DashboardAccount, DashboardLine } from '@core/models/DashboardFamilies'
import { HistoryRow } from '@core/models/HistoryRow'
import { LimitResourceSource } from '@core/models/LimitResourceDescriptor'
import { MenuBarContent, MenuBarContentBuilder } from '@core/models/MenuBarContent'
import type { MetricKind } from '@core/models/MetricKind'
import { metricValue, type MetricValue } from '@core/models/MetricValue'
import { PriorityBoard, PriorityItem, PriorityReason, type PinnedMetric } from '@core/models/PriorityBoard'
import type { Provider } from '@core/models/Provider'
import { UsageWindow } from '@core/models/UsageHistory'
import { WidgetData, type MeterSeverity } from '@core/models/WidgetData'
import { WidgetDescriptor } from '@core/models/WidgetDescriptor'
import { DashboardRowModel } from '@core/models/DashboardRowModel'
import { Formatters } from '@core/support/Formatters'
import { addSeconds, fromUnixSeconds, type Instant, type Seconds } from '@core/support/time'
import { accountOf as account } from './MockData'

/**
 * The descriptors `AccountProviderRuntime.widgetDescriptors(for:)` builds for the rows these tests read,
 * restated from `AccountProviderRuntime+Descriptors.swift` because the runtime is outside this suite.
 */
const realDescriptors: Record<string, (provider: Provider) => WidgetDescriptor> = {
  'cursor.credits': (provider) =>
    WidgetDescriptor.values({ key: 'credits', provider, title: 'Credits', valueWord: 'left' }).exportingLimit('credits', {
      kind: 'balance',
      unit: 'usd',
      source: LimitResourceSource.value('dollars')
    }),
  'cursor.last30': (provider) =>
    HistoryRow.descriptor('last30', provider, HistoryRow.window(UsageWindow.lastDays(30), 'spend', 'tokens')),
  'codex.credits': (provider) =>
    WidgetDescriptor.values({ key: 'credits', provider, title: 'Extra Usage', metricLabel: 'Credits' }).exportingLimit('credits', {
      kind: 'balance',
      unit: 'credits',
      source: LimitResourceSource.value('count', 'credits')
    }),
  'codex.rateLimitResets': rateLimitResets,
  'claude.rateLimitResets': rateLimitResets,
  'openrouter.balance': (provider) =>
    WidgetDescriptor.values({ key: 'balance', provider, title: 'Balance', valueWord: 'left' }).exportingLimit('balance', {
      kind: 'balance',
      unit: 'usd',
      source: LimitResourceSource.value('dollars')
    }),
  'openrouter.today': (provider) => HistoryRow.descriptor('today', provider, HistoryRow.window(UsageWindow.today, 'spend')),
  'copilot.extra': (provider) =>
    WidgetDescriptor.values({ key: 'extra', provider, title: 'Extra Usage' }).exportingLimit('extraUsage', {
      unit: 'count',
      source: LimitResourceSource.value('count')
    })
}

function rateLimitResets(provider: Provider): WidgetDescriptor {
  return WidgetDescriptor.values({
    key: 'rateLimitResets',
    provider,
    title: 'Limit Resets',
    metricLabel: 'Rate Limit Resets',
    showsResetExpiries: true
  }).exportingLimit('rateLimitResets', { kind: 'balance', unit: 'resets', source: LimitResourceSource.value('count', 'available') })
}

describe('PriorityBoardTests', () => {
  const now = fromUnixSeconds(1_800_000_000)
  const hour: Seconds = 3600
  const day: Seconds = 24 * 3600
  const week: Seconds = 7 * day

  const chatGPT: Provider = { id: 'codex@1', kind: 'codex', accountLabel: 'ChatGPT' }
  const personal: Provider = { id: 'claude@1', kind: 'claude', accountLabel: 'Personal' }
  const work: Provider = { id: 'claude@2', kind: 'claude', accountLabel: 'Work' }

  function paced(title: string, used: number, left: Seconds, period: Seconds = week): WidgetData {
    const data = new WidgetData({ title, kind: 'percent', used, limit: 100 })
    data.resetsAt = addSeconds(now, left)
    data.periodDurationMs = Math.trunc(period * 1000)
    return data
  }

  function unpaced(title: string, used: number, limit = 100): WidgetData {
    return new WidgetData({ title, kind: 'dollars', used, limit })
  }

  const board = (...accounts: DashboardAccount[]): PriorityBoard => PriorityBoard.make({ accounts, now })

  const ids = (items: PriorityItem[]): string[] => items.map(PriorityItem.id)
  const pinnedIDs = (pins: PinnedMetric[]): string[] => pins.map((pin) => DashboardLine.id(pin.line))
  const severities = (items: PriorityItem[]): MeterSeverity[] => items.map((item) => PriorityReason.severity(item.reason))

  it('testALimitIsListedAt30PercentLeftHoweverSlowOrFastItIsBurning', () => {
    const result = board(
      account(
        personal,
        paced('At 30%, Nearly Reset', 70, hour),
        paced('At 30%, Fresh', 70, 6.9 * day),
        paced('More Than 30%, Burning Fast', 69, 6.9 * day)
      )
    )

    expect(new Set(ids(result.attention))).toEqual(new Set(['claude@1.At 30%, Nearly Reset', 'claude@1.At 30%, Fresh']))
  })

  it('testTheClockNeverChangesWhatIsListed', () => {
    const accounts = [account(personal, paced('Weekly', 75, 4 * day), paced('Fable', 40, 4 * day))]
    for (const later of [0, hour, day, 3 * day]) {
      const result = PriorityBoard.make({ accounts, now: addSeconds(now, later) })
      expect(ids(result.attention), `${later} seconds later`).toEqual(['claude@1.Weekly'])
    }
  })

  it('testOrangeAt30PercentLeftAndRedAtATenthLeft', () => {
    const severity = (used: number): MeterSeverity | undefined => {
      const first = board(account(personal, unpaced('Credits', used))).attention[0]
      return first ? PriorityReason.severity(first.reason) : undefined
    }
    expect(severity(69)).toBeUndefined()
    expect(severity(70)).toBe('warning')
    expect(severity(89)).toBe('warning')
    expect(severity(90)).toBe('critical')
  })

  it('testTheSoonestToRunOutComesFirstWhateverIsLeft', () => {
    const result = board(
      account(personal, paced('Weekly', 75, 3.5 * day), paced('Session', 75, 2.5 * hour, 5 * hour), unpaced('Extra Usage', 95))
    )

    expect(ids(result.attention), 'a limit with no pace to tell by follows the ones that have one').toEqual([
      'claude@1.Session',
      'claude@1.Weekly',
      'claude@1.Extra Usage'
    ])
  })

  it('testEqualRanksKeepTheSavedOrder', () => {
    const limit = paced('Weekly', 75, 3.5 * day)
    expect(ids(board(account(personal, limit), account(work, limit)).attention)).toEqual(['claude@1.Weekly', 'claude@2.Weekly'])
    expect(ids(board(account(work, limit), account(personal, limit)).attention)).toEqual(['claude@2.Weekly', 'claude@1.Weekly'])

    const level = unpaced('Credits', 80)
    expect(ids(board(account(work, level), account(personal, level)).attention)).toEqual(['claude@2.Credits', 'claude@1.Credits'])
  })

  it('testLimitsWithNoPaceFollowThePacedOnesLeastLeftFirst', () => {
    const result = board(
      account(personal, unpaced('Warning', 80), unpaced('Critical', 95), unpaced('Fine', 40)),
      account(work, unpaced('Warned More', 170, 200), paced('Paced', 75, 3.5 * day))
    )

    expect(ids(result.attention)).toEqual(['claude@2.Paced', 'claude@1.Critical', 'claude@2.Warned More', 'claude@1.Warning'])
    expect(severities(result.attention)).toEqual(['warning', 'critical', 'warning', 'warning'])
  })

  it('testTheLevelOrderIgnoresTheUsedOrLeftSetting', () => {
    const most = unpaced('Most', 95)
    const least = unpaced('Least', 80)
    most.displayMode = 'remaining'
    least.displayMode = 'remaining'
    expect(ids(board(account(personal, least, most)).attention)).toEqual(['claude@1.Most', 'claude@1.Least'])
  })

  it('testUsedUpLimitsSortBySoonestResetWithNoResetLastAndNeverNeedAttention', () => {
    const result = board(
      account(personal, unpaced('No Reset', 100), paced('Later', 100, 2 * day)),
      account(work, paced('Sooner', 100, 3 * hour), paced('Running Out', 75, 3.5 * day))
    )

    expect(ids(result.usedUp)).toEqual(['claude@2.Sooner', 'claude@1.Later', 'claude@1.No Reset'])
    expect(ids(result.attention)).toEqual(['claude@2.Running Out'])
    expect(result.usedUp[1].reason).toEqual({ type: 'usedUp', resetsAt: addSeconds(now, 2 * day) })
  })

  it('testHealthyQuietUnreportedAndUnboundedLinesAreNotListed', () => {
    const unreported = paced('Unreported', 60, 3.5 * day)
    unreported.hasData = false
    const balance = new WidgetData({ title: 'Balance', kind: 'dollars', used: 0, limit: undefined })
    balance.values = [metricValue(12, 'dollars', undefined)]

    const result = board(account(personal, paced('Healthy', 20, 3.5 * day), unpaced('Quiet', 10), unreported, balance))

    expect(result.attention).toEqual([])
    expect(result.usedUp).toEqual([])
  })

  function realLine(kind: string, key: string, values: MetricValue[], expiries: Instant[] = []): DashboardLine {
    const make = realDescriptors[`${kind}.${key}`]
    if (!make) throw new Error(`${kind} has no ${key}`)
    const descriptor = make({ id: kind, kind: kind as Provider['kind'] })
    const data = descriptor.sample.with({ values, expiriesAt: expiries, limit: undefined })
    return { descriptor, data }
  }

  const zero = (kind: MetricKind, label?: string): MetricValue => metricValue(0, kind, label)

  // testExactlyTheseMetricsAreBalances and testNothingButABalanceReachesUsedUpAtZero walk every provider's
  // `AccountProviderRuntime.widgetDescriptors(for:)`: not ported here.

  it('testAnOpenBalanceAtZeroIsUsedUpAndShowsItsAmountInsteadOfATime', () => {
    const cursor = realLine('cursor', 'credits', [zero('dollars')])
    const codex = realLine('codex', 'credits', [zero('dollars'), zero('count', 'credits')])
    const result = PriorityBoard.make({
      accounts: [DashboardAccount.make(personal, [cursor]), DashboardAccount.make(chatGPT, [codex])],
      now
    })

    expect(result.attention, 'a balance has no pace or limit to run toward').toEqual([])
    expect(ids(result.usedUp)).toEqual([DashboardLine.id(cursor), DashboardLine.id(codex)])
    expect(result.usedUp.map((item) => PriorityItem.usedUpNote(item, now))).toEqual(['$0 left', '$0'])
    expect(severities(result.usedUp)).toEqual(['critical', 'critical'])
    expect(result.summary).toBe('listed')
    expect(MenuBarContent.isEmpty(MenuBarContentBuilder.build(result, 'upToFive')), 'a balance never reaches the menu bar').toBe(true)
  })

  it('testAnEmptyBalanceRanksAfterEveryLimitWithAReset', () => {
    const balance = realLine('openrouter', 'balance', [zero('dollars')])
    const result = PriorityBoard.make({
      accounts: [DashboardAccount.make(personal, [balance]), account(work, paced('Later', 100, 20 * day), paced('Sooner', 100, hour))],
      now
    })

    expect(ids(result.usedUp)).toEqual(['claude@2.Sooner', 'claude@2.Later', DashboardLine.id(balance)])
  })

  it('testAPinnedEmptyBalanceIsListedOnlyUnderUsedUp', () => {
    const balance = realLine('openrouter', 'balance', [zero('dollars')])
    const healthy = paced('Weekly', 10, day)
    const result = PriorityBoard.make({
      accounts: [DashboardAccount.make(personal, [balance]), account(work, healthy)],
      pinned: new Set([DashboardLine.id(balance), 'claude@2.Weekly']),
      now
    })

    expect(pinnedIDs(result.pinned)).toEqual(['claude@2.Weekly'])
    expect(ids(result.usedUp)).toEqual([DashboardLine.id(balance)])
    expect(result.usedUp.map((item) => item.isPinned), 'its menu offers Unpin').toEqual([true])
    expect(result.summary).toBe('listed')
    expect(result.showsClearRow).toBe(true)

    const onlyHealthy = PriorityBoard.make({ accounts: [account(work, healthy)], pinned: new Set(['claude@2.Weekly']), now })
    expect(onlyHealthy.summary).toBe('allClear')
    expect(PriorityBoard.hasRows(onlyHealthy), 'a healthy pin alone can still be copied as a picture').toBe(true)
    expect(PriorityBoard.hasRows(PriorityBoard.make({ accounts: [account(work, healthy)], now }))).toBe(false)
  })

  it('testAPinnedMetricRunningOutOrUsedUpIsListedOnlyThereUntilItIsNot', () => {
    const pins = new Set(['claude@1.Session', 'claude@1.Weekly', 'claude@1.Monthly'])
    const pinnedBoard = (sessionUsed: number, monthlyUsed: number): PriorityBoard =>
      PriorityBoard.make({
        accounts: [
          account(personal, paced('Session', sessionUsed, hour), paced('Weekly', 20, day), paced('Monthly', monthlyUsed, day))
        ],
        pinned: pins,
        now
      })

    const runningOut = pinnedBoard(95, 100)
    expect(ids(runningOut.attention)).toEqual(['claude@1.Session'])
    expect(runningOut.attention.map((item) => item.isPinned), 'its menu offers Unpin').toEqual([true])
    expect(ids(runningOut.usedUp)).toEqual(['claude@1.Monthly'])
    expect(runningOut.usedUp.map((item) => item.isPinned), "so does a used-up pin's").toEqual([true])
    expect(pinnedIDs(runningOut.pinned)).toEqual(['claude@1.Weekly'])
    expect(runningOut.showsClearRow).toBe(false)

    const recovered = pinnedBoard(20, 0)
    expect(recovered.attention).toEqual([])
    expect(recovered.usedUp).toEqual([])
    expect(pinnedIDs(recovered.pinned), 'back under Pinned in dashboard order').toEqual([
      'claude@1.Session',
      'claude@1.Weekly',
      'claude@1.Monthly'
    ])

    const allRunningOut = PriorityBoard.make({
      accounts: [account(personal, paced('Session', 95, hour))],
      pinned: new Set(['claude@1.Session']),
      now
    })
    expect(allRunningOut.pinned, 'no Pinned section while every pin is running out').toEqual([])
    expect(ids(allRunningOut.attention)).toEqual(['claude@1.Session'])
  })

  it('testABalanceWithAnythingLeftIsNotListed', () => {
    const cents = realLine('cursor', 'credits', [metricValue(0.01, 'dollars')])
    const credits = realLine('codex', 'credits', [metricValue(0.04, 'dollars'), metricValue(1, 'count', 'credits')])
    const result = PriorityBoard.make({ accounts: [DashboardAccount.make(personal, [cents, credits])], now })

    expect(result.attention).toEqual([])
    expect(result.usedUp).toEqual([])
  })

  it('testABalanceMeasuredAgainstALimitFollowsTheLimitRules', () => {
    const descriptor = realDescriptors['cursor.credits']({ id: 'cursor', kind: 'cursor' })
    const low = unpaced('Credits', 90)
    low.values = [zero('dollars')]
    const result = PriorityBoard.make({ accounts: [DashboardAccount.make(personal, [{ descriptor, data: low }])], now })

    expect(result.attention.map((item) => item.reason)).toEqual([{ type: 'low', severity: 'critical', remaining: 0.1, runway: undefined }])
    expect(result.usedUp).toEqual([])
  })

  it('testSpendTotalsAndLimitResetsAtZeroAreNotUsedUp', () => {
    const lines = [
      realLine('openrouter', 'today', [zero('dollars')]),
      realLine('cursor', 'last30', [zero('dollars'), zero('count', 'tokens')]),
      realLine('copilot', 'extra', [zero('count')]),
      realLine('claude', 'rateLimitResets', [zero('count', 'available')]),
      realLine('codex', 'rateLimitResets', [zero('count', 'available')], [addSeconds(now, day)])
    ]
    expect(
      lines.find((line) => line.descriptor.limitResources.some((resource) => resource.kind === 'balance')),
      "Limit Resets export as a balance and still don't count"
    ).toBeDefined()

    const result = PriorityBoard.make({ accounts: [DashboardAccount.make(personal, lines)], now })

    expect(result.usedUp).toEqual([])
    expect(result.attention).toEqual([])
  })

  it('testAUsedUpLimitsNoteIsTheBareTimeUntilItResets', () => {
    const limit = paced('Weekly', 100, 22 * hour + 10 * 60)
    let result = board(account(personal, limit))
    expect(PriorityItem.usedUpNote(result.usedUp[0], now)).toBe('22h 10m')

    limit.resetDisplayMode = 'absolute'
    result = board(account(personal, limit))
    expect(PriorityItem.usedUpNote(result.usedUp[0], now)).toBe(Formatters.compactClock(addSeconds(now, 22 * hour + 10 * 60), now))

    limit.resetDisplayMode = 'relative'
    limit.resetsAt = addSeconds(now, -1)
    limit.periodDurationMs = undefined
    result = board(account(personal, limit))
    expect(PriorityItem.usedUpNote(result.usedUp[0], now)).toBe('soon')

    expect(PriorityItem.usedUpNote(board(account(personal, unpaced('Credits', 100))).usedUp[0], now)).toBeUndefined()
  })

  it('testTheSummarySaysWhetherThereIsAnythingToReport', () => {
    const unreported = paced('Unreported', 60, 3.5 * day)
    unreported.hasData = false
    const balance = new WidgetData({ title: 'Balance', kind: 'dollars', used: 0, limit: undefined })
    balance.values = [metricValue(12, 'dollars', undefined)]

    expect(board().summary).toBe('waitingForUsage')
    expect(board(account(personal)).summary).toBe('waitingForUsage')
    expect(board(account(personal, unreported, balance)).summary).toBe('noReportedLimits')
    expect(board(account(personal, unpaced('Quiet', 10))).summary).toBe('allClear')
    expect(board(account(personal, unpaced('Spent', 100))).summary).toBe('listed')
    expect(board(account(personal, unpaced('Warning', 80))).summary).toBe('listed')
  })

  // testAReportedAccountDoesNotWaitForALimitItWillNeverHave, testFailedRefreshIsVisibleBesideOtherAlertsAndSharesWithoutAccountDetails
  // and testAnAccountIsASkeletonOnBothTabsUntilItsFirstReadingAndAFailureIsNot run through `WidgetDataStore`.
  // What the store passes `make` for a failed account is a `status` of `.unavailable`:
  it('an account whose read failed is a notice beside what the others list', () => {
    const email = 'private@example.com'
    const provider: Provider = { id: 'claude@1', kind: 'claude', accountLabel: email }
    const accounts = [account(provider, unpaced('Weekly', 15)), account(work, unpaced('Weekly', 75))]
    const status = (failed: DashboardAccount) =>
      DashboardAccount.id(failed) === provider.id
        ? ({ type: 'unavailable', message: `Replace the token for ${email}.` } as const)
        : ({ type: 'current' } as const)

    const alone = PriorityBoard.make({ accounts: [accounts[0]], now, status })
    expect(alone.summary).toBe('unavailable')

    const live = PriorityBoard.make({ accounts, now, status })
    expect(live.summary).toBe('listed')
    expect(ids(live.attention)).toEqual(['claude@2.Weekly'])
    expect(live.notices.map((notice) => notice.message)).toEqual([`Replace the token for ${email}.`])
    expect(live.showsClearRow).toBe(false)

    const shared = PriorityBoard.make({ accounts: accounts.map(DashboardAccount.hidingEmail), now, status })
    expect(shared.notices[0].provider.accountLabel).toBeUndefined()
  })

  it('testEachAccountWithoutAReadingWaitsInItsOwnRowBesideWhatHasReported', () => {
    const firstLaunch = board(account(personal), account(chatGPT))
    expect(firstLaunch.waiting.map((provider) => provider.id)).toEqual([personal.id, chatGPT.id])
    expect(firstLaunch.summary).toBe('waitingForUsage')
    expect(firstLaunch.showsClearRow).toBe(false)

    const mixed = board(account(personal, unpaced('Warning', 80)), account(chatGPT))
    expect(ids(mixed.attention)).toEqual(['claude@1.Warning'])
    expect(mixed.waiting.map((provider) => provider.id), 'a pending account still shows while another is running out').toEqual([
      chatGPT.id
    ])
    const quiet = board(account(personal, unpaced('Quiet', 10)), account(chatGPT))
    expect(quiet.waiting.map((provider) => provider.id)).toEqual([chatGPT.id])
    expect(quiet.showsClearRow, "All Clear can't speak for an account that hasn't reported").toBe(false)

    const reported = board(account(personal, unpaced('Warning', 80)), account(chatGPT, unpaced('Quiet', 10)))
    expect(reported.waiting).toEqual([])
    expect(reported.summary).toBe('listed')
  })

  // Not an upstream case: the Used Up note of a reset that is due reads the same as its row's reset.
  it('a used-up row and its dashboard row read the same reset', () => {
    const limit = paced('Weekly', 100, 3 * hour)
    const item = board(account(personal, limit)).usedUp[0]
    expect(PriorityItem.usedUpNote(item, now)).toBe(DashboardRowModel.compactResetText(limit, now))
  })
})
