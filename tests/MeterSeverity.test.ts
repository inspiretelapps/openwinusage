import { describe, expect, it } from 'vitest'
import { WidgetData, type MeterSeverity } from '@core/models/WidgetData'
import type { WidgetDisplayMode } from '@core/models/WidgetDisplayMode'
import { fromUnixSeconds } from '@core/support/time'

describe('MeterSeverityTests', () => {
  const now = fromUnixSeconds(1_700_000_000)

  function percentData(used: number, limit: number | undefined = 100, displayMode: WidgetDisplayMode = 'used'): WidgetData {
    return new WidgetData({ title: 'Session', kind: 'percent', used, limit, displayMode })
  }

  /** `percentData(used:limit: nil)`: an explicit nil limit, which a default parameter can't express. */
  function unboundedPercentData(used: number): WidgetData {
    return new WidgetData({ title: 'Session', kind: 'percent', used, limit: undefined, displayMode: 'used' })
  }

  it('testTheBandsUseRoundedPercentagesLeft', () => {
    const cases: [used: number, severity: MeterSeverity][] = [
      [69.4, 'normal'],
      [69.6, 'warning'],
      [70, 'warning'],
      [89.4, 'warning'],
      [89.6, 'critical'],
      [90, 'critical']
    ]

    for (const [used, severity] of cases) {
      expect(percentData(used).severity, `used: ${used}`).toBe(severity)
    }
  })

  it('testNonPercentKindsBandOnTheirShareOfTheLimit', () => {
    const dollars = new WidgetData({ title: 'Credits', kind: 'dollars', used: 45, limit: 50 })
    expect(dollars.severity).toBe('critical')

    expect(new WidgetData({ title: 'Requests', kind: 'count', used: 375, limit: 500 }).severity).toBe('warning')
    expect(new WidgetData({ title: 'Requests', kind: 'count', used: 240, limit: 500 }).severity).toBe('normal')
  })

  it('testUnboundedZeroLimitAndUnreportedMetricsStayNormal', () => {
    expect(unboundedPercentData(99).severity).toBe('normal')
    expect(percentData(99, 0).severity).toBe('normal')
    const data = percentData(95)
    data.hasData = false
    expect(data.severity).toBe('normal')
    expect(data.meterState(now)).toBe('noData')
  })
})
