import { describe, expect, it } from 'vitest'
import { WidgetData } from '@core/models/WidgetData'
import type { WidgetDisplayMode } from '@core/models/WidgetDisplayMode'
import { Pace } from '@core/support/Pace'
import { addSeconds, fromUnixSeconds, type Instant, type Seconds } from '@core/support/time'

describe('PaceTests', () => {
  const now = fromUnixSeconds(1_700_000_000)
  const week: Seconds = 7 * 24 * 60 * 60

  function resetsAt(elapsed: number, period: Seconds): Instant {
    return addSeconds(now, period * (1 - elapsed))
  }

  it('testWindowAlreadyResetReturnsNil', () => {
    const past = addSeconds(now, -60)
    expect(Pace.evaluate(50, 100, past, week, now)).toBeUndefined()
    expect(Pace.evaluate(50, 100, now, week, now)).toBeUndefined()
  })

  function pacedData(used: number, elapsed = 0.5, period: Seconds = week, displayMode: WidgetDisplayMode = 'used'): WidgetData {
    const data = new WidgetData({ title: 'Weekly', kind: 'percent', used, limit: 100, displayMode })
    data.resetsAt = resetsAt(elapsed, period)
    data.periodDurationMs = Math.trunc(period * 1000)
    return data
  }

  it('testNoPaceVerdictWithoutAResetWindow', () => {
    const data = new WidgetData({ title: 'Credits', kind: 'dollars', used: 12, limit: 20 })
    expect(data.meterState(now)).toBe('unpaced')
    data.resetsAt = addSeconds(now, week)
    expect(data.meterState(now)).toBe('unpaced')
  })

  it('testThePaceVerdictPicksTheMeterState', () => {
    expect(pacedData(30).meterState(now)).toBe('healthy')
    expect(pacedData(44).meterState(now)).toBe('healthy')
    expect(pacedData(46).meterState(now)).toBe('closeToLimit')
    expect(pacedData(60).meterState(now)).toBe('runningOut')
    expect(pacedData(50.2).meterState(now)).toBe('runningOut')
  })

  it('testZeroUsageHasNoPaceState', () => {
    expect(pacedData(0).meterState(now)).toBe('unpaced')
  })

  it('testSpentOutranksThePaceVerdict', () => {
    expect(pacedData(100).meterState(now)).toBe('spent')
    const nearlyEmpty = new WidgetData({ title: 'Credits', kind: 'dollars', used: 99.999, limit: 100 })
    expect(nearlyEmpty.meterState(now)).toBe('spent')
    const withHeadroom = new WidgetData({ title: 'Credits', kind: 'dollars', used: 99.0, limit: 100 })
    expect(withHeadroom.meterState(now)).toBe('unpaced')

    const data = new WidgetData({ title: 'Weekly', kind: 'percent', used: 99.6, limit: 100 })
    data.resetsAt = resetsAt(0.997, week)
    data.periodDurationMs = Math.trunc(week * 1000)
    expect(data.meterState(now)).toBe('spent')
  })

  it('testProjectionAtOrRoundedToLimitIsRunningOut', () => {
    for (const used of [49.8, 50]) {
      expect(pacedData(used).meterState(now), `${used}% used`).toBe('runningOut')
    }
  })

  it('testSmallButRealCushionStaysAmber', () => {
    expect(pacedData(49).meterState(now)).toBe('closeToLimit')
  })

  it('testPlentyRemainingSuppressesFalseRunOutFlame', () => {
    const session: Seconds = 5 * 3600
    const elapsed = 240 / session
    const data = pacedData(2, elapsed, session)
    expect(data.meterState(now)).toBe('unpaced')
  })

  it('testOnePercentAtProjectionGateDoesNotBecomeRed', () => {
    const session: Seconds = 5 * 3600
    expect(pacedData(1, 0.01, session).meterState(now)).toBe('unpaced')
  })

  it('testRunOutFlameShowsOnceFivePercentUsedDespiteHighRemaining', () => {
    const session: Seconds = 5 * 3600
    const elapsed = 240 / session
    const data = pacedData(6, elapsed, session)
    expect(data.meterState(now), 'expected runningOut when burning fast with ≥5% used').toBe('runningOut')
  })

  it('testPaceProjectionWaitsUntilWindowHasMateriallyStarted', () => {
    const session: Seconds = 5 * 3600
    const elapsed = 60 / session
    const reset = resetsAt(elapsed, session)
    expect(Pace.evaluate(1, 100, reset, session, now)).toBeUndefined()
  })
})
