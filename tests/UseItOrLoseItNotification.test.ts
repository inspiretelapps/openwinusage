import { describe, expect, it } from 'vitest'
import { WidgetData } from '@core/models/WidgetData'
import { MetricPeriod } from '@core/support/MetricPeriod'
import { NotificationState, PaceMilestone, PaceNotificationLogic } from '@core/support/PaceNotificationLogic'
import { addSeconds, fromUnixSeconds, type Instant, type Seconds } from '@core/support/time'

describe('UseItOrLoseItNotificationTests', () => {
  const day: Seconds = 24 * 60 * 60
  const start = fromUnixSeconds(1_700_000_000)
  const reset = addSeconds(start, day + 3600)

  function weekly(used: number, resetsAt: Instant = reset, periodMs: number | undefined = MetricPeriod.weekMs): WidgetData {
    const data = new WidgetData({ title: 'Weekly', kind: 'percent', used, limit: 100 })
    data.resetsAt = resetsAt
    data.periodDurationMs = periodMs
    return data
  }

  /** `weekly(used:periodMs: nil)`: an explicit nil, which a default parameter can't express. */
  function withoutPeriod(used: number): WidgetData {
    const data = weekly(used)
    data.periodDurationMs = undefined
    return data
  }

  it('testFiresAtTwentyFourHoursWithOverHalfLeft', () => {
    const atLead = addSeconds(reset, -day)
    expect(PaceNotificationLogic.isUnusedNearReset(weekly(49), atLead)).toBe(true)
    expect(PaceNotificationLogic.isUnusedNearReset(weekly(49), addSeconds(atLead, -1)), 'more than 24 hours before the reset').toBe(false)
    expect(PaceNotificationLogic.isUnusedNearReset(weekly(50), atLead), 'exactly half left is not over half').toBe(false)
    expect(PaceNotificationLogic.isUnusedNearReset(weekly(49), reset), 'the window already reset').toBe(false)
  })

  it('testSkipsSessionAndDailyWindows', () => {
    const soon = addSeconds(reset, -3600)
    expect(PaceNotificationLogic.isUnusedNearReset(weekly(10, reset, MetricPeriod.sessionMs), soon)).toBe(false)
    expect(PaceNotificationLogic.isUnusedNearReset(weekly(10, reset, MetricPeriod.dayMs), soon)).toBe(false)
    expect(PaceNotificationLogic.isUnusedNearReset(withoutPeriod(10), soon)).toBe(false)
    expect(PaceNotificationLogic.isUnusedNearReset(weekly(10, reset, MetricPeriod.monthMs), soon)).toBe(true)
  })

  it('testSkipsDollarSpendCaps', () => {
    const cap = new WidgetData({ title: 'Key Limit', kind: 'dollars', used: 20, limit: 100 })
    cap.resetsAt = reset
    cap.periodDurationMs = MetricPeriod.monthMs
    expect(PaceNotificationLogic.isUnusedNearReset(cap, addSeconds(reset, -3600))).toBe(false)
  })

  // The four evaluator cases (testFiresOncePerWindowAndReArmsOnTheNextWindow, testSessionWindowNeverFiresThroughTheEvaluator,
  // testOffSettingPostsNothing, testColdStartInsideTheLastDayPrimesWithoutFiring) drive `QuotaNotificationEvaluator`
  // (Stores). The transitions it steps through are checked here: the evaluator records what it posted in
  // `firedMilestones`, which this does by hand.
  describe('the transitions behind the evaluator', () => {
    function evaluate(data: WidgetData, at: Instant, previous: NotificationState): { fire: PaceMilestone[]; state: NotificationState } {
      const transition = PaceNotificationLogic.transitions({
        state: data.meterState(at),
        severity: data.severity,
        resetsAt: data.resetsAt,
        unusedNearReset: PaceNotificationLogic.isUnusedNearReset(data, at),
        previous
      })
      const fire = transition.fire.filter((milestone) => milestone === PaceMilestone.useItOrLoseIt)
      for (const milestone of fire) transition.newState.firedMilestones.add(milestone)
      return { fire, state: transition.newState }
    }

    it('fires once per window and re-arms on the next window', () => {
      let step = evaluate(weekly(20), start, NotificationState.initial())
      expect(step.fire, 'more than 24 hours before the reset').toEqual([])

      step = evaluate(weekly(20), addSeconds(reset, -day), step.state)
      expect(step.fire).toEqual([PaceMilestone.useItOrLoseIt])
      expect(PaceMilestone.notificationTitle(PaceMilestone.useItOrLoseIt)).toBe('Use It or Lose It')
      expect(PaceMilestone.body(PaceMilestone.useItOrLoseIt, { warning: 30, critical: 10 })).toBe('Over 50% left, resets in under 24 hours.')

      step = evaluate(weekly(30), addSeconds(reset, -3600), step.state)
      expect(step.fire, 'once per reset window').toEqual([])

      const nextReset = addSeconds(reset, 7 * day)
      step = evaluate(weekly(0, nextReset), addSeconds(reset, 60), step.state)
      expect(step.fire).toEqual([])
      step = evaluate(weekly(40, nextReset), addSeconds(nextReset, -3600), step.state)
      expect(step.fire, 'a new window re-arms it').toEqual([PaceMilestone.useItOrLoseIt])
    })

    it('a session window never fires', () => {
      const session = weekly(10, reset, MetricPeriod.sessionMs)
      let step = evaluate(session, start, NotificationState.initial())
      expect(step.fire).toEqual([])
      step = evaluate(session, addSeconds(reset, -3600), step.state)
      expect(step.fire).toEqual([])
    })

    it('a cold start inside the last day primes without firing', () => {
      let step = evaluate(weekly(20), addSeconds(reset, -3600), NotificationState.initial())
      expect(step.fire).toEqual([])
      step = evaluate(weekly(20), addSeconds(reset, -1800), step.state)
      expect(step.fire).toEqual([])
    })
  })
})
