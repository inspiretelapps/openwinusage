import { describe, expect, it } from 'vitest'
import type { MetricLine } from '@core/models/MetricLine'
import { CodexUsageMapper } from '@core/providers/codex/CodexUsageMapper'
import { HTTPResponse } from '@core/services/HTTPClient'
import { MetricPeriod } from '@core/support/MetricPeriod'
import { addSeconds, type Instant } from '@core/support/time'
import { unix } from './TestSupport'

interface Meter {
  label: string
  used: number
  resetsAt: Instant | undefined
  periodMs: number | undefined
}

describe('CodexWindowClassificationTests', () => {
  const now = unix(1_800_000_000)

  function meters(lines: MetricLine[]): Meter[] {
    return lines.flatMap((line): Meter[] => {
      if (line.type !== 'progress' || line.limit !== 100 || line.format.type !== 'percent') return []
      return [{ label: line.label, used: line.used, resetsAt: line.resetsAt, periodMs: line.periodDurationMs }]
    })
  }

  function windows(rateLimit: string): Meter[] {
    const response = new HTTPResponse(200, {}, `{"rate_limit":${rateLimit}}`)
    return meters(CodexUsageMapper.mapUsageResponse(response, undefined, now).lines)
  }

  it('testAWeeklyWindowInThePrimarySlotIsTheWeeklyMeter', () => {
    const found = windows('{"primary_window":{"used_percent":30,"limit_window_seconds":604800,"reset_after_seconds":100}}')

    expect(found.map((meter) => meter.label)).toEqual(['Weekly'])
    expect(found[0]?.used).toBe(30)
    expect(found[0]?.periodMs).toBe(MetricPeriod.weekMs)
    expect(found[0]?.resetsAt).toBe(addSeconds(now, 100))
  })

  it('testSwappedSlotsAreReadByDuration', () => {
    const found = windows(
      '{"primary_window":{"used_percent":70,"limit_window_seconds":604800},"secondary_window":{"used_percent":20,"limit_window_seconds":18000}}'
    )

    expect(found.map((meter) => meter.label)).toEqual(['Session', 'Weekly'])
    expect(found.map((meter) => meter.used)).toEqual([20, 70])
  })

  it('testAnUnfamiliarDurationStaysInItsSlotWithItsOwnPeriod', () => {
    const found = windows(
      '{"primary_window":{"used_percent":10,"limit_window_seconds":3600},"secondary_window":{"used_percent":40,"limit_window_seconds":2592000}}'
    )

    expect(found.map((meter) => meter.label)).toEqual(['Session', 'Weekly'])
    expect(found.map((meter) => meter.used)).toEqual([10, 40])
    expect(found.map((meter) => meter.periodMs)).toEqual([3_600_000, 2_592_000_000])
  })

  it('testAMatchedWindowWithoutAPercentShowsNothingAndBorrowsNoOtherWindow', () => {
    const found = windows(
      '{"primary_window":{"limit_window_seconds":604800},"secondary_window":{"used_percent":40,"limit_window_seconds":86400}}'
    )

    expect(found.map((meter) => meter.label)).toEqual([])
  })

  it('testAHeaderPercentAloneIsTheSlotsMeterWithTheDefaultPeriod', () => {
    const response = new HTTPResponse(200, { 'x-codex-primary-used-percent': '55' }, '{"rate_limit":{}}')
    const found = meters(CodexUsageMapper.mapUsageResponse(response, undefined, now).lines)

    expect(found.map((meter) => meter.label)).toEqual(['Session'])
    expect(found[0]?.used).toBe(55)
    expect(found[0]?.periodMs).toBe(MetricPeriod.sessionMs)
    expect(found[0]?.resetsAt).toBeUndefined()
  })
})
