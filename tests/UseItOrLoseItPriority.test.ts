import { describe, expect, it } from 'vitest'
import { BurningFast } from '@core/models/BurningFast'
import { MenuBarContent, MenuBarContentBuilder } from '@core/models/MenuBarContent'
import type { MetricKind } from '@core/models/MetricKind'
import { PriorityBoard, PriorityItem, PriorityReason } from '@core/models/PriorityBoard'
import type { Provider } from '@core/models/Provider'
import { WidgetData } from '@core/models/WidgetData'
import { MetricPeriod } from '@core/support/MetricPeriod'
import { PaceNotificationLogic } from '@core/support/PaceNotificationLogic'
import { addSeconds, fromUnixSeconds, type Seconds } from '@core/support/time'
import { accountOf as account } from './MockData'

describe('UseItOrLoseItPriorityTests', () => {
  const now = fromUnixSeconds(1_800_000_000)
  const hour: Seconds = 3600

  const personal: Provider = { id: 'claude@1', kind: 'claude', accountLabel: 'Personal' }
  const chatGPT: Provider = { id: 'codex@1', kind: 'codex', accountLabel: 'ChatGPT' }

  function limit(title: string, used: number, resetsIn: Seconds, periodMs: number = MetricPeriod.weekMs, kind: MetricKind = 'percent'): WidgetData {
    const data = new WidgetData({ title, kind, used, limit: 100 })
    data.resetsAt = addSeconds(now, resetsIn)
    data.periodDurationMs = periodMs
    return data
  }

  const ids = (items: PriorityItem[]): string[] => items.map(PriorityItem.id)

  it('testListsLimitsAboutToResetUnusedInTheirOwnSectionSoonestResetFirstAndOnlyWithTheSwitchOn', () => {
    const accounts = [
      account(
        personal,
        limit('Weekly', 30, 18 * hour),
        limit('Session', 10, 2 * hour, MetricPeriod.sessionMs),
        limit('Daily', 10, 3 * hour, MetricPeriod.dayMs),
        limit('Half', 50, 4 * hour),
        limit('Later', 10, 25 * hour)
      ),
      account(chatGPT, limit('Weekly', 20, 6 * hour), limit('Key Limit', 10, 5 * hour, MetricPeriod.monthMs, 'dollars'))
    ]

    const board = PriorityBoard.make({ accounts, burningFast: new BurningFast(), useItOrLoseIt: true, now })

    expect(
      ids(board.useItOrLoseIt),
      'soonest reset first; sessions, daily windows, exactly half left, over a day out, and dollar caps stay off'
    ).toEqual(['codex@1.Weekly', 'claude@1.Weekly'])
    expect(board.useItOrLoseIt.map((item) => PriorityItem.resetsInText(item, now))).toEqual(['Resets in 6h', 'Resets in 18h'])
    expect(
      board.useItOrLoseIt.map((item) => PriorityReason.severity(item.reason)),
      "the ring keeps meaning what's left"
    ).toEqual(['normal', 'normal'])
    expect(board.attention, 'nothing here is running out').toEqual([])
    expect(board.showsClearRow, 'Running Out still says All Clear').toBe(true)
    expect(board.summary).toBe('listed')
    expect(MenuBarContent.isEmpty(MenuBarContentBuilder.build(board, 'upToFive')), 'the menu bar is for running out').toBe(true)

    const off = PriorityBoard.make({ accounts, burningFast: new BurningFast(), useItOrLoseIt: false, now })
    expect(off.useItOrLoseIt).toEqual([])
    expect(off.summary).toBe('allClear')
  })

  it('testListsExactlyWhatTheAlertWouldFireFor', () => {
    for (const periodMs of [MetricPeriod.sessionMs, MetricPeriod.dayMs, MetricPeriod.weekMs, MetricPeriod.monthMs]) {
      for (const kind of ['percent', 'dollars'] as MetricKind[]) {
        for (const used of [0.0, 30, 49, 49.6, 50, 51]) {
          for (const resetsIn of [-hour, 1, hour, 24 * hour, 24 * hour + 1]) {
            const data = limit('Weekly', used, resetsIn, periodMs, kind)
            const board = PriorityBoard.make({ accounts: [account(personal, data)], useItOrLoseIt: true, now })
            expect(board.useItOrLoseIt.length > 0, `${kind} ${periodMs}ms window, ${used} used, resets in ${resetsIn}s`).toBe(
              PaceNotificationLogic.isUnusedNearReset(data, now)
            )
          }
        }
      }
    }
  })

  it('testAPinnedLimitAboutToResetUnusedMovesOutOfPinned', () => {
    const accounts = [account(personal, limit('Weekly', 30, 18 * hour))]
    const board = PriorityBoard.make({ accounts, pinned: new Set(['claude@1.Weekly']), useItOrLoseIt: true, now })
    expect(ids(board.useItOrLoseIt)).toEqual(['claude@1.Weekly'])
    expect(board.useItOrLoseIt.map((item) => item.isPinned)).toEqual([true])
    expect(board.pinned).toEqual([])
    expect(board.showsClearRow).toBe(true)
  })

  // testTheStoreSwitchDefaultsToOnAndSurvivesARelaunch needs `WidgetDataStore`.
})
