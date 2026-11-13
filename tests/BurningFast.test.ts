import { describe, expect, it } from 'vitest'
import { BurningFast } from '@core/models/BurningFast'
import { MenuBarContentBuilder } from '@core/models/MenuBarContent'
import { PriorityBoard, PriorityItem, PriorityReason } from '@core/models/PriorityBoard'
import type { Provider } from '@core/models/Provider'
import { WidgetData } from '@core/models/WidgetData'
import { addSeconds, fromUnixSeconds, type Seconds } from '@core/support/time'
import { accountOf as account } from './MockData'

describe('BurningFastTests', () => {
  const now = fromUnixSeconds(1_800_000_000)
  const hour: Seconds = 3600
  const day: Seconds = 24 * 3600
  const week: Seconds = 7 * day
  const session: Seconds = 5 * hour

  const personal: Provider = { id: 'claude@1', kind: 'claude', accountLabel: 'Personal' }
  const chatGPT: Provider = { id: 'codex@1', kind: 'codex', accountLabel: 'ChatGPT' }

  /** A limit `elapsed` into its window, which is a week unless said otherwise. */
  function paced(title: string, used: number, elapsed: number, period: Seconds = week): WidgetData {
    const data = new WidgetData({ title, kind: 'percent', used, limit: 100 })
    data.resetsAt = addSeconds(now, (1 - elapsed) * period)
    data.periodDurationMs = Math.trunc(period * 1000)
    return data
  }

  const ids = (items: PriorityItem[]): string[] => items.map(PriorityItem.id)

  it('testALimitBurningFastJoinsRunningOutWithPlentyLeftRankedByWhenItRunsOut', () => {
    const accounts = [
      account(
        personal,
        paced('Session', 27, (25 * 60) / (5 * hour), session),
        paced('Weekly', 76, 5.5 / 7),
        paced('Steady', 40, 0.5)
      ),
      account(chatGPT, paced('Weekly', 9, (6 * hour) / (7 * day)), new WidgetData({ title: 'Credits', kind: 'dollars', used: 80, limit: 100 }))
    ]

    const board = PriorityBoard.make({ accounts, burningFast: new BurningFast(), now })

    expect(ids(board.attention), 'soonest to run out first, whatever is left, then what has no pace').toEqual([
      'claude@1.Session',
      'claude@1.Weekly',
      'codex@1.Weekly',
      'codex@1.Credits'
    ])
    expect(
      board.attention.map((item) => PriorityReason.severity(item.reason)),
      "the ring keeps meaning what's left"
    ).toEqual(['normal', 'warning', 'normal', 'warning'])
    expect(
      board.attention.map((item) => PriorityItem.runOutText(item, now)),
      'only a limit listed for burning fast says when it runs out'
    ).toEqual(['Out in 1h 8m', undefined, 'Out in 2d 12h', undefined])
    expect(MenuBarContentBuilder.build(board, 'upToTwo').items.map((item) => item.id)).toEqual(['claude@1.Session', 'claude@1.Weekly'])

    const off = PriorityBoard.make({ accounts, burningFast: undefined, now })
    expect(ids(off.attention), 'with the setting off only low limits are listed').toEqual(['claude@1.Weekly', 'codex@1.Credits'])
  })

  it('testAPinnedLimitBurningFastMovesToRunningOut', () => {
    const accounts = [account(personal, paced('Weekly', 60, 0.5))]
    const board = PriorityBoard.make({ accounts, pinned: new Set(['claude@1.Weekly']), burningFast: new BurningFast(), now })
    expect(ids(board.attention)).toEqual(['claude@1.Weekly'])
    expect(board.attention.map((item) => item.isPinned)).toEqual([true])
    expect(board.pinned).toEqual([])
    expect(board.showsClearRow).toBe(false)
  })

  it('testABurningLimitStaysListedUntilItsPaceEasesToNinetyPercent', () => {
    const nearlyEven = account(personal, paced('Weekly', 47.5, 0.5))
    const eased = account(personal, paced('Weekly', 42.5, 0.5))
    const latched = new BurningFast(new Map([['claude@1.Weekly', addSeconds(now, week / 2)]]))

    expect(
      PriorityBoard.make({ accounts: [nearlyEven], burningFast: new BurningFast(), now }).attention,
      "95% of the limit by reset doesn't start listing it"
    ).toEqual([])
    expect(
      ids(PriorityBoard.make({ accounts: [nearlyEven], burningFast: latched, now }).attention),
      'but keeps one listed that was burning'
    ).toEqual(['claude@1.Weekly'])
    expect(PriorityBoard.make({ accounts: [eased], burningFast: latched, now }).attention, '85% lets it go').toEqual([])
  })

  // testTheStoreRemembersWhatWasBurningAtItsLastReadingAndTheSettingDefaultsToOn needs `WidgetDataStore`.
  // Its model half - what a latch from another window is worth, and when a listed limit stops saying
  // when it runs out - is checked here without the store.
  it('a latch holds through one window only, and an eased pace shows the reset instead of a run-out time', () => {
    const start = addSeconds(now, -week / 2)
    const reading = (used: number, window = 0): WidgetData => {
      const data = new WidgetData({ title: 'Weekly', kind: 'percent', used, limit: 100 })
      data.resetsAt = addSeconds(start, (window + 1) * week)
      data.periodDurationMs = Math.trunc(week * 1000)
      return data
    }
    const latched = new BurningFast(new Map([['claude@1.Weekly', addSeconds(start, week)]]))
    const listed = (data: WidgetData, at: number, burningFast: BurningFast): PriorityItem[] =>
      PriorityBoard.make({ accounts: [account(personal, data)], burningFast, now: at }).attention

    const burning = listed(reading(60), now, new BurningFast())
    expect(ids(burning), '60% used halfway through the week').toEqual(['claude@1.Weekly'])
    expect(PriorityItem.runOutText(burning[0], now)).toBe('Out in 2d 8h')

    const easing = addSeconds(start, 0.63 * week)
    const stillListed = listed(reading(60), easing, latched)
    expect(ids(stillListed), 'its pace eased to 95% with no new usage: still listed').toEqual(['claude@1.Weekly'])
    expect(PriorityItem.runOutText(stillListed[0], easing), 'it would no longer run out before the reset').toBeUndefined()
    expect(listed(reading(60), easing, new BurningFast()), 'a reading taken once it eased forgets it was burning').toEqual([])

    expect(listed(reading(60), addSeconds(start, 0.72 * week), latched), '83% lets it go').toEqual([])
    expect(
      listed(reading(47, 1), addSeconds(start, 1.5 * week), latched),
      "a new window at 94% of the limit doesn't inherit the last one burning"
    ).toEqual([])
    expect(latched.wasBurning('claude@1.Weekly', reading(47, 1))).toBe(false)
    expect(latched.wasBurning('claude@1.Weekly', reading(60))).toBe(true)
  })
})
