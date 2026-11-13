import { describe, expect, it } from 'vitest'
import { WidgetData, type MeterState } from '@core/models/WidgetData'
import { NotificationState, PaceMilestone, PaceNotificationLogic, type PaceTransition } from '@core/support/PaceNotificationLogic'
import { addSeconds, fromUnixSeconds, type Instant } from '@core/support/time'

describe('PaceNotificationLogicTests', () => {
  const reset = fromUnixSeconds(1_700_000_000)

  const healthy: MeterState = 'healthy'
  const close: MeterState = 'closeToLimit'
  const running: MeterState = 'runningOut'

  function step(
    state: MeterState,
    options: { fraction?: number; resetsAt?: Instant; from?: NotificationState } = {}
  ): PaceTransition {
    const fraction = options.fraction ?? 0.9
    return PaceNotificationLogic.transitions({
      state,
      severity: new WidgetData({ title: 'Weekly', kind: 'percent', used: (1 - fraction) * 100, limit: 100 }).severity,
      resetsAt: options.resetsAt ?? reset,
      unusedNearReset: false,
      previous: options.from ?? NotificationState.initial()
    })
  }

  it('testTheLevelsTurnOverExactlyWhereTheBarsChangeColor', () => {
    const primed = step(healthy, { fraction: 0.31 }).newState
    expect(step(healthy, { fraction: 0.3, from: primed }).fire).toEqual([PaceMilestone.warning])
    const orange = step(healthy, { fraction: 0.11, from: primed }).newState
    expect(step(healthy, { fraction: 0.1, from: orange }).fire).toEqual([PaceMilestone.critical])
  })

  it('testDroppingStraightUnderTenOffersBothLevelsLowestFirst', () => {
    const primed = step(healthy).newState
    expect(step(healthy, { fraction: 0.05, from: primed }).fire).toEqual([PaceMilestone.critical, PaceMilestone.warning])
  })

  it('testWillRunOutReArmsOnlyOnceThePaceEasesToNinetyPercent', () => {
    let state = step(running, { from: step(healthy).newState }).newState
    state.firedMilestones.add(PaceMilestone.closeToRunningOut)
    state = step(close, { from: state }).newState
    expect(step(running, { from: state }).fire, "easing to 95% and back doesn't fire it again").toEqual([])
    state = step(healthy, { from: state }).newState
    expect(step(running, { from: state }).fire).toEqual([PaceMilestone.closeToRunningOut])
  })

  it('testUnderTenPercentFiresOncePerWindow', () => {
    const primed = step(close, { fraction: 0.5 }).newState
    const first = step(close, { fraction: 0.08, from: primed })
    expect(first.fire).toContain(PaceMilestone.critical)
    // Upstream's store adds what it posted to `firedMilestones`; this test passes the state straight back,
    // so it is the level bookkeeping (`previousSeverity`) that keeps Critical from firing again.
    const again = step(close, { fraction: 0.05, from: first.newState })
    expect(again.fire).not.toContain(PaceMilestone.critical)
  })

  it('testColdStartPrimesWithoutFiring', () => {
    const first = step(running, { fraction: 0.02 })
    expect(first.fire, "cold start primes, it doesn't fire").toEqual([])
    expect(step('unpaced', { fraction: 0.01 }).fire).toEqual([])
    expect(step('unpaced', { fraction: 0.99 }).fire).toEqual([])
    const recovered = step(healthy, { fraction: 0.5, from: first.newState }).newState
    const red = step(running, { fraction: 0.02, from: recovered })
    expect(red.fire).toContain(PaceMilestone.closeToRunningOut)
    expect(red.fire).toContain(PaceMilestone.critical)
  })

  it('testResetRolloverClearsFiredSetSoItCanFireAgain', () => {
    let state = step(healthy).newState
    state = step(running, { from: state }).newState
    expect(step(running, { from: state }).fire).toEqual([])
    const newReset = addSeconds(reset, 3600)
    const rolled = step(healthy, { resetsAt: newReset, from: state }).newState
    const refired = step(running, { resetsAt: newReset, from: rolled })
    expect(refired.fire).toEqual([PaceMilestone.closeToRunningOut])
  })

  it('testRecoveryThenReworseningRefires', () => {
    let state = step(healthy).newState
    state = step(healthy, { fraction: 0.25, from: state }).newState
    state = step(running, { fraction: 0.25, from: state }).newState
    state = step(healthy, { from: state }).newState
    const orange = step(healthy, { fraction: 0.25, from: state })
    expect(orange.fire).toEqual([PaceMilestone.warning])
    const red2 = step(running, { fraction: 0.25, from: orange.newState })
    expect(red2.fire).toEqual([PaceMilestone.closeToRunningOut])
  })

  it('testUnderTenPercentReArmsAfterRecoveryAboveTen', () => {
    const primed = step(close, { fraction: 0.5 }).newState
    const first = step(close, { fraction: 0.05, from: primed })
    expect(first.fire).toContain(PaceMilestone.critical)
    const recovered = step(close, { fraction: 0.5, from: first.newState })
    expect(recovered.fire).not.toContain(PaceMilestone.critical)
    const dipsAgain = step(close, { fraction: 0.05, from: recovered.newState })
    expect(dipsAgain.fire).toContain(PaceMilestone.critical)
  })

  it('testUnpacedLimitFiresOnlyAlmostOutUnderTenPercent', () => {
    const primed = step('unpaced', { fraction: 0.2 }).newState
    const first = step('unpaced', { fraction: 0.08, from: primed })
    expect(first.fire).toContain(PaceMilestone.critical)
    expect(first.fire).not.toContain(PaceMilestone.warning)
    expect(first.fire).not.toContain(PaceMilestone.closeToRunningOut)
  })

  it('testUntrackedDoesNotDisturbPreviousSignals', () => {
    let state = step(healthy).newState
    state = step('noData', { fraction: 0.5, from: state }).newState
    expect(step(healthy, { fraction: 0.25, from: state }).fire).toEqual([PaceMilestone.warning])
  })

  // Swift's `NotificationState` is a value: a transition never changes the state it was given.
  it('leaves the previous state untouched', () => {
    const primed = step(healthy).newState
    const before = NotificationState.copy(primed)
    const next = step(running, { fraction: 0.05, from: primed }).newState
    next.firedMilestones.add(PaceMilestone.critical)
    expect(primed).toEqual(before)
  })
})
