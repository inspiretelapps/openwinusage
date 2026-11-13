import { describe, expect, it } from 'vitest'
import { DashboardAccount, type DashboardLine } from '@core/models/DashboardFamilies'
import { MenuBarContent, MenuBarContentBuilder } from '@core/models/MenuBarContent'
import { MenuBarLimit } from '@core/models/MenuBarLimit'
import type { MetricKind } from '@core/models/MetricKind'
import { metricValue } from '@core/models/MetricValue'
import { PriorityBoard } from '@core/models/PriorityBoard'
import { Provider } from '@core/models/Provider'
import { WidgetData } from '@core/models/WidgetData'
import { WidgetDescriptor } from '@core/models/WidgetDescriptor'
import { addSeconds, fromUnixSeconds } from '@core/support/time'
import { accountOf as account } from './MockData'

describe('MenuBarContentTests', () => {
  const now = fromUnixSeconds(1_800_000_000)
  const personal: Provider = { id: 'claude@1', kind: 'claude', accountLabel: 'Personal' }
  const chatGPT: Provider = { id: 'codex@1', kind: 'codex', accountLabel: 'ChatGPT' }

  function limit(title: string, used: number, kind: MetricKind = 'percent'): WidgetData {
    return new WidgetData({ title, kind, used, limit: 100 })
  }

  function content(
    limit: MenuBarLimit,
    options: { pinned?: string[]; alwaysShows?: boolean },
    ...accounts: DashboardAccount[]
  ): MenuBarContent {
    return MenuBarContentBuilder.build(
      PriorityBoard.make({ accounts, pinned: new Set(options.pinned ?? []), now }),
      limit,
      options.alwaysShows ?? false
    )
  }

  function sevenLimits(): DashboardAccount {
    return account(
      personal,
      limit('A', 99),
      limit('B', 98),
      limit('C', 97),
      limit('D', 96),
      limit('E', 95),
      limit('F', 94),
      limit('G', 93)
    )
  }

  it('testTheMostUrgentLimitsShowUpToTheSettingAndTheRestBecomeTheOverflow', () => {
    const cases: [MenuBarLimit, string[], number][] = [
      ['upToOne', ['A'], 6],
      ['upToTwo', ['A', 'B'], 5],
      ['upToThree', ['A', 'B', 'C'], 4],
      ['upToFour', ['A', 'B', 'C', 'D'], 3],
      ['upToFive', ['A', 'B', 'C', 'D', 'E'], 2]
    ]
    for (const [setting, labels, overflow] of cases) {
      const strip = content(setting, {}, sevenLimits())
      expect(strip.items.map((item) => item.shortLabel), MenuBarLimit.label(setting)).toEqual(labels)
      expect(strip.overflow, MenuBarLimit.label(setting)).toBe(overflow)
    }
  })

  it('testTheStripReranksAtResetEvenWithoutANewReading', () => {
    const session = limit('Session', 75)
    session.resetsAt = addSeconds(now, 20)
    session.periodDurationMs = 5 * 60 * 60 * 1_000
    const accounts = [account(personal, session, limit('Budget', 95))]
    const before = PriorityBoard.make({ accounts, now })
    const after = PriorityBoard.make({ accounts, now: addSeconds(now, 30) })

    expect(PriorityBoard.requiresRankingClock(before, now)).toBe(true)
    expect(MenuBarContentBuilder.build(before, 'upToOne').items[0]?.label).toBe('Session')
    expect(PriorityBoard.requiresRankingClock(after, addSeconds(now, 30))).toBe(false)
    expect(MenuBarContentBuilder.build(after, 'upToOne').items[0]?.label).toBe('Budget')
    const single = PriorityBoard.make({ accounts: [account(personal, session)], now })
    expect(PriorityBoard.requiresRankingClock(single, now)).toBe(false)
  })

  it('testIconOnlyShowsNoLimitsAndNoOverflow', () => {
    const strip = content('iconOnly', {}, sevenLimits())
    expect(MenuBarContent.isEmpty(strip)).toBe(true)
    expect(strip.overflow).toBe(0)
    // `MenuBarStripRenderer.image(for:)` is AppKit drawing: no port.
  })

  it('testNothingNeedingAttentionShowsTheAppIcon', () => {
    const strip = content('upToThree', {}, account(personal, limit('Quiet', 10)))
    expect(strip).toEqual(MenuBarContent.make([]))
    expect(MenuBarContent.equal(strip, MenuBarContent.make([]))).toBe(true)
  })

  it('testUsedUpLimitsNeverShowAndNeverCountTowardTheOverflow', () => {
    const strip = content(
      'upToOne',
      {},
      account(personal, limit('Spent', 100), limit('Spent Too', 100), limit('Low', 95), limit('Lower', 90))
    )
    expect(strip.items.map((item) => item.shortLabel)).toEqual(['Low'])
    expect(strip.overflow, "only Lower waits; Spent and Spent Too aren't running out").toBe(1)
  })

  it('testAlwaysShowingListsUsedUpLimitsAfterRunningOutWithoutCountingThemTowardTheOverflow', () => {
    const accounts = account(personal, limit('Spent', 100), limit('Spent Too', 100), limit('Low', 95), limit('Lower', 90))
    const one = content('upToOne', { alwaysShows: true }, accounts)
    expect(one.items.map((item) => item.shortLabel)).toEqual(['Low'])
    expect(one.overflow, 'only Lower waits; Used Up never counts').toBe(1)

    const five = content('upToFive', { alwaysShows: true }, accounts)
    expect(five.items.map((item) => item.shortLabel)).toEqual(['Low', 'Lower', 'Spent', 'Spent Too'])
    expect(five.items.map((item) => item.value)).toEqual(['95%', '90%', '100%', '100%'])
    expect(five.overflow).toBe(0)

    const left = limit('Spent', 100)
    left.displayMode = 'remaining'
    expect(content('upToOne', { alwaysShows: true }, account(personal, left)).items.map((item) => item.value)).toEqual(['0%'])
  })

  it('testAlwaysShowingWithTheStripFullOfRunningOutLeavesUsedUpOutOfTheCount', () => {
    const strip = content(
      'upToThree',
      { alwaysShows: true },
      account(
        personal,
        limit('Low', 95),
        limit('Lower', 92),
        limit('Lowest', 90),
        limit('Spent', 100),
        limit('Spent Too', 100),
        limit('Spent Three', 100)
      )
    )
    expect(strip.items.map((item) => item.shortLabel)).toEqual(['Low', 'Lower', 'Lowest'])
    expect(strip.overflow).toBe(0)
    expect(MenuBarContent.accessibilityText(strip).includes('more')).toBe(false)
  })

  it('testPinnedLimitsShowWithNothingRunningOutOnlyWhenAlwaysShowing', () => {
    const accounts = [account(personal, limit('Session', 10), limit('Weekly', 40)), account(chatGPT, limit('Session', 20))]
    const board = PriorityBoard.make({ accounts, pinned: new Set(['claude@1.Weekly', 'codex@1.Session']), now })

    const strip = MenuBarContentBuilder.build(board, 'upToThree', true)
    expect(strip.items.map((item) => item.id)).toEqual(['claude@1.Weekly', 'codex@1.Session'])
    expect(strip.items.map((item) => item.value)).toEqual(['40%', '20%'])
    expect(strip.overflow).toBe(0)
    expect(MenuBarContentBuilder.build(board, 'upToThree'), 'off, pins stay out').toEqual(MenuBarContent.make([]))
  })

  it('testAPinnedMetricWithoutALimitShowsItsAmount', () => {
    const provider: Provider = { id: 'openrouter', kind: 'openrouter' }
    const descriptor = WidgetDescriptor.values({ key: 'balance', provider, title: 'Balance' })
    const data = descriptor.sample.with({ values: [metricValue(12, 'dollars')] })
    const account = DashboardAccount.make(provider, [{ descriptor, data }])
    const board = PriorityBoard.make({ accounts: [account], pinned: new Set([descriptor.id]), now })

    expect(MenuBarContentBuilder.build(board, 'upToOne', true).items.map((item) => item.value)).toEqual(['$12'])
  })

  it('testAPinnedLimitWithoutAReadingShowsADashAsItsRowDoes', () => {
    const weekly = limit('Weekly', 0)
    weekly.hasData = false
    const strip = content('upToOne', { pinned: ['claude@1.Weekly'], alwaysShows: true }, account(personal, weekly))
    expect(strip.items.map((item) => item.value)).toEqual([WidgetData.noDataValue])
  })

  it('testAlwaysShowingFollowsThePriorityTabTopToBottomUpToTheSetting', () => {
    const reset = limit('Reset Soon', 20)
    reset.resetsAt = addSeconds(now, 6 * 3600)
    reset.periodDurationMs = 7 * 24 * 3600 * 1000
    const accounts = [
      account(personal, limit('Spent', 100), reset, limit('Pin B', 20), limit('Low', 95)),
      account(chatGPT, limit('Pin A', 10))
    ]
    const board = PriorityBoard.make({
      accounts,
      pinned: new Set(['codex@1.Pin A', 'claude@1.Pin B']),
      useItOrLoseIt: true,
      now
    })

    const five = MenuBarContentBuilder.build(board, 'upToFive', true)
    expect(
      five.items.map((item) => item.shortLabel),
      "Pinned, Running Out, Use It or Lose It, then Used Up, each in the tab's order"
    ).toEqual(['Pin B', 'Pin A', 'Low', 'Reset Soon', 'Spent'])
    const three = MenuBarContentBuilder.build(board, 'upToThree', true)
    expect(three.items.map((item) => item.shortLabel)).toEqual(['Pin B', 'Pin A', 'Low'])
    expect(three.overflow, 'Reset Soon waits; Used Up never counts').toBe(1)

    const off = MenuBarContentBuilder.build(board, 'upToThree')
    expect(off.items.map((item) => item.shortLabel), "off, only what's running out").toEqual(['Low'])
    expect(off.overflow).toBe(0)
  })

  it('testAPinnedLimitThatIsRunningOutShowsOnceAsRunningOut', () => {
    const strip = content(
      'upToFive',
      { pinned: ['claude@1.Low', 'claude@1.Quiet'], alwaysShows: true },
      account(personal, limit('Quiet', 10), limit('Low', 95))
    )
    expect(strip.items.map((item) => item.shortLabel)).toEqual(['Quiet', 'Low'])
    expect(strip.overflow).toBe(0)
  })

  it('testNoAccountsShowTheAppIconEvenWithPins', () => {
    const strip = content('upToThree', { pinned: ['claude@1.Weekly'], alwaysShows: true })
    expect(strip).toEqual(MenuBarContent.make([]))
    // `MenuBarStripRenderer.image(for:)` is AppKit drawing: no port.
  })

  it('testEveryItemNamesItsLimitAndCarriesItsValue', () => {
    const dollars = limit('Extra Usage', 95, 'dollars')
    dollars.displayMode = 'remaining'
    const strip = content('upToThree', {}, account(personal, limit('Session', 96), dollars))

    expect(strip.items.map((item) => item.id)).toEqual(['claude@1.Session', 'claude@1.Extra Usage'])
    expect(strip.items.map((item) => item.shortLabel)).toEqual(['Session', 'Extra'])
    expect(strip.items.map((item) => item.label)).toEqual(['Session', 'Extra Usage'])
    expect(strip.items.map((item) => item.value)).toEqual(['96%', '$5'])
    expect(strip.overflow).toBe(0)
  })

  it('testAnAccountsLimitsKeepTheirRankRatherThanGathering', () => {
    const strip = content('upToThree', {}, account(personal, limit('A', 99), limit('C', 97)), account(chatGPT, limit('B', 98)))
    expect(strip.items.map((item) => item.shortLabel)).toEqual(['A', 'B', 'C'])
  })

  // testThePreviewShowsExactlyTheNumberPicked and testThePreviewShrinksAWideStripToFitAndKeepsItsProportions
  // exercise `PriorityIconsPreview` (Views).

  it('testTheShortLabelDropsATrailingGenericWordWhenAWordRemains', () => {
    const cases: Record<string, string> = {
      'Cursor Models': 'Cursor',
      'Grok Bot': 'Grok',
      'Extra USAGE': 'Extra',
      Usage: 'Usage',
      'Usage Limit': 'Usage Limit'
    }
    for (const [label, short] of Object.entries(cases)) {
      expect(MenuBarContentBuilder.shortLabel(label), label).toBe(short)
    }
  })

  it('testAccessibilityTextReadsEveryItemInFullAndTheOverflow', () => {
    const models = limit('Cursor Models', 96)
    models.displayMode = 'used'
    const strip = content('upToOne', {}, account(chatGPT, models), account(personal, limit('Session', 90)))
    expect(MenuBarContent.accessibilityText(strip)).toBe(`${Provider.fullName(chatGPT)} Cursor Models 96%; 1 more`)

    expect(
      MenuBarContent.accessibilityText(content('upToThree', {}, account(personal, limit('Session', 96), limit('Weekly', 95))))
    ).toBe(`${Provider.fullName(personal)} Session 96%; ${Provider.fullName(personal)} Weekly 95%`)

    // What `fullName` reads: an account named for its provider adds nothing beside it.
    expect(Provider.fullName(chatGPT)).toBe('ChatGPT')
    expect(Provider.fullName(personal)).toBe('Claude · Personal')
    const update = MenuBarContent.make([], 2, true)
    expect(MenuBarContent.accessibilityText(update)).toBe('2 more; Update available')
  })

  // testThePersistedSettingDefaultsToUpToThreeAndSurvivesARelaunch needs `WidgetDataStore`.

  it('testALimitIsNamedAsThePanelNamesIt', () => {
    const provider: Provider = { id: 'cursor', kind: 'cursor' }
    const data = new WidgetData({ title: 'Extra Usage', kind: 'dollars', used: 400, limit: 500 })
    const descriptor = new WidgetDescriptor(provider, 'onDemand', 'On-demand', data)
    const line: DashboardLine = { descriptor, data }
    const account = DashboardAccount.make(provider, [line])
    const board = PriorityBoard.make({ accounts: [account], now: Date.now() })

    expect(MenuBarContentBuilder.build(board, 'upToFive').items.map((item) => item.shortLabel)).toEqual(['Extra'])
  })
})
