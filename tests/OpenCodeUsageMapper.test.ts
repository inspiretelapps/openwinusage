import { describe, expect, it } from 'vitest'
import { ProgressFormat, type MetricLine, type ProgressLine } from '@core/models/MetricLine'
import { OpenCodeUsageMapper } from '@core/providers/opencode/OpenCodeUsageMapper'
import { ProviderError } from '@core/providers/ProviderError'
import { HTTPResponse } from '@core/services/HTTPClient'
import { MetricPeriod } from '@core/support/MetricPeriod'
import { OpenUsageISO8601 } from '@core/support/OpenUsageISO8601'
import type { JSONObject } from '@core/support/ProviderParse'
import { addSeconds, type Instant } from '@core/support/time'
import { unix } from './TestSupport'

const sampleBody: JSONObject = {
  usage: {
    rolling: { status: 'ok', percent: 12, resetsAt: '2026-07-12T13:30:00.662Z' },
    weekly: { status: 'ok', percent: 8, resetsAt: '2026-07-13T00:00:00.662Z' },
    monthly: { status: 'rate-limited', percent: 100, resetsAt: '2026-08-04T11:18:32.662Z' }
  }
}

/** `guard case let .progress(...) = line else { return XCTFail(message) }` */
function progress(line: MetricLine, message: string): ProgressLine {
  if (line.type !== 'progress') throw new Error(message)
  return line
}

function thrown(body: () => unknown): unknown {
  try {
    body()
  } catch (error) {
    return error
  }
  throw new Error('expected a throw')
}

function expectInvalidResponse(body: () => unknown): void {
  const error = thrown(body)
  expect(ProviderError.is(error) && error.equals(ProviderError.invalidResponse)).toBe(true)
}

describe('OpenCodeUsageMapperTests', () => {
  it('testMeterLinesMatchDashboardPercentsAndResets', () => {
    const lines = OpenCodeUsageMapper.meterLines(sampleBody)
    expect(lines.map((line) => line.label)).toEqual(['Session', 'Weekly', 'Monthly'])

    const session = progress(lines[0], 'session is not a progress line')
    expect(session.used).toBe(12)
    expect(session.limit).toBe(100)
    expect(session.format).toEqual(ProgressFormat.percent)
    expect(session.resetsAt).toBe(OpenUsageISO8601.date('2026-07-12T13:30:00.662Z'))
    expect(session.periodDurationMs).toBe(MetricPeriod.sessionMs)

    const weekly = progress(lines[1], 'weekly is not a progress line')
    expect(weekly.used).toBe(8)
    expect(weekly.format).toEqual(ProgressFormat.percent)
    expect(weekly.resetsAt).toBe(OpenUsageISO8601.date('2026-07-13T00:00:00.662Z'))
    expect(weekly.periodDurationMs).toBe(MetricPeriod.weekMs)

    const monthly = progress(lines[2], 'monthly is not a progress line')
    expect(monthly.used).toBe(100)
    expect(monthly.format).toEqual(ProgressFormat.percent)
    expect(monthly.periodDurationMs).toBe(MetricPeriod.monthMs)
  })

  it('testZeroPercentIsARealMeterNotNoData', () => {
    const body: JSONObject = {
      usage: {
        rolling: { percent: 0, resetsAt: '2026-07-12T17:00:00.000Z' },
        weekly: { percent: 0, resetsAt: '2026-07-13T00:00:00.000Z' },
        monthly: { percent: 0, resetsAt: '2026-08-04T00:00:00.000Z' }
      }
    }
    const lines = OpenCodeUsageMapper.meterLines(body)
    const session = progress(lines[0], 'session is not a progress line')
    expect(session.used).toBe(0)
    expect(session.limit).toBe(100)
    expect(session.format).toEqual(ProgressFormat.percent)
  })

  /**
   * An untouched rolling window has nothing to roll off, so the API answers `resetsAt = now + 5h`
   * and slides it forward every request. That placeholder is dropped at capture time so the Session
   * row reads "Not started" off the missing reset rather than counting down to a moving target.
   */
  it('testUntouchedRollingWindowDropsPlaceholderReset', () => {
    const capturedAt = unix(1_800_000_000)
    const placeholder = addSeconds(capturedAt, 5 * 3600 + 0.8) // live endpoint overshoots slightly
    const body: JSONObject = {
      usage: {
        rolling: { percent: 0, resetsAt: OpenUsageISO8601.string(placeholder) },
        weekly: { percent: 1, resetsAt: OpenUsageISO8601.string(addSeconds(capturedAt, 3 * 86_400)) },
        monthly: { percent: 0, resetsAt: OpenUsageISO8601.string(addSeconds(capturedAt, 20 * 86_400)) }
      }
    }
    const lines = OpenCodeUsageMapper.meterLines(body, capturedAt)
    const session = progress(lines[0], 'session is not a progress line')
    expect(session.used).toBe(0)
    expect(session.resetsAt).toBeUndefined()
  })

  it('testSubOnePercentRollingWindowKeepsAnchoredReset', () => {
    const capturedAt = unix(1_800_000_000)
    const period = MetricPeriod.sessionMs / 1000
    for (const age of [30.0, 60.0]) {
      const anchored = addSeconds(capturedAt, period - age)
      const body: JSONObject = {
        usage: {
          rolling: { percent: 0, resetsAt: OpenUsageISO8601.string(anchored) },
          weekly: { percent: 1, resetsAt: OpenUsageISO8601.string(addSeconds(capturedAt, 3 * 86_400)) },
          monthly: { percent: 0, resetsAt: OpenUsageISO8601.string(addSeconds(capturedAt, 20 * 86_400)) }
        }
      }
      const lines = OpenCodeUsageMapper.meterLines(body, capturedAt)
      const session = progress(lines[0], 'session is not a progress line')
      expect(session.used).toBe(0)
      expect(session.resetsAt, `active session aged ${age}s lost its reset`).toBe(anchored)
    }
  })

  it('testPlaceholderComparisonIsBoundedOnBothSides', () => {
    const capturedAt = unix(1_800_000_000)
    const period = MetricPeriod.sessionMs / 1000

    const mappedReset = (offset: number): Instant | undefined => {
      const reset = addSeconds(capturedAt, period + offset)
      const body: JSONObject = {
        usage: {
          rolling: { percent: 0, resetsAt: OpenUsageISO8601.string(reset) },
          weekly: { percent: 0, resetsAt: OpenUsageISO8601.string(addSeconds(capturedAt, 3 * 86_400)) },
          monthly: { percent: 0, resetsAt: OpenUsageISO8601.string(addSeconds(capturedAt, 20 * 86_400)) }
        }
      }
      const lines = OpenCodeUsageMapper.meterLines(body, capturedAt)
      return progress(lines[0], 'session is not a progress line').resetsAt
    }

    expect(mappedReset(-OpenCodeUsageMapper.placeholderResetTolerance)).toBeUndefined()
    expect(mappedReset(OpenCodeUsageMapper.placeholderResetTolerance)).toBeUndefined()
    expect(mappedReset(-OpenCodeUsageMapper.placeholderResetTolerance - 0.5)).toBeDefined()
    expect(mappedReset(OpenCodeUsageMapper.placeholderResetTolerance + 0.5)).toBeDefined()
    expect(mappedReset(5 * 60), 'an implausibly distant reset is not a placeholder').toBeDefined()
  })

  it('testHTTPDateHeaderWinsOverSkewedLocalClock', () => {
    const serverDate = OpenUsageISO8601.date('2027-01-15T08:00:00.000Z')
    if (serverDate === undefined) throw new Error('bad fixture date')
    const placeholder = addSeconds(serverDate, 5 * 3600 + 0.5)
    const body: JSONObject = {
      usage: {
        rolling: { percent: 0, resetsAt: OpenUsageISO8601.string(placeholder) },
        weekly: { percent: 0, resetsAt: '2027-01-18T00:00:00.000Z' },
        monthly: { percent: 0, resetsAt: '2027-02-10T08:00:00.000Z' }
      }
    }
    const response = new HTTPResponse(200, { date: 'Fri, 15 Jan 2027 08:00:00 GMT' }, JSON.stringify(body))
    const lines = OpenCodeUsageMapper.meterLines(response, addSeconds(serverDate, 2 * 60))
    expect(progress(lines[0], 'session is not a progress line').resetsAt).toBeUndefined()
  })

  it('testMissingOrMalformedHTTPDateFallsBackToCapturedAt', () => {
    const capturedAt = unix(1_800_000_000)
    const placeholder = addSeconds(capturedAt, 5 * 3600 + 0.5)
    const body: JSONObject = {
      usage: {
        rolling: { percent: 0, resetsAt: OpenUsageISO8601.string(placeholder) },
        weekly: { percent: 0, resetsAt: OpenUsageISO8601.string(addSeconds(capturedAt, 3 * 86_400)) },
        monthly: { percent: 0, resetsAt: OpenUsageISO8601.string(addSeconds(capturedAt, 20 * 86_400)) }
      }
    }
    const data = JSON.stringify(body)
    const headerSets: Record<string, string>[] = [{}, { date: 'not-an-http-date' }]
    for (const headers of headerSets) {
      const response = new HTTPResponse(200, headers, data)
      const lines = OpenCodeUsageMapper.meterLines(response, capturedAt)
      expect(progress(lines[0], 'session is not a progress line').resetsAt).toBeUndefined()
    }
  })

  it('testFullPeriodWeeklyAndMonthlyResetsSurviveAtZeroUsage', () => {
    const capturedAt = unix(1_800_000_000)
    const weeklyReset = addSeconds(capturedAt, 7 * 86_400)
    const monthlyReset = addSeconds(capturedAt, 30 * 86_400)
    const body: JSONObject = {
      usage: {
        rolling: { percent: 0, resetsAt: OpenUsageISO8601.string(addSeconds(capturedAt, 2 * 3600)) },
        weekly: { percent: 0, resetsAt: OpenUsageISO8601.string(weeklyReset) },
        monthly: { percent: 0, resetsAt: OpenUsageISO8601.string(monthlyReset) }
      }
    }
    const lines = OpenCodeUsageMapper.meterLines(body, capturedAt)
    const weekly = progress(lines[1], 'expected progress lines')
    const monthly = progress(lines[2], 'expected progress lines')
    expect(weekly.resetsAt).toBe(weeklyReset)
    expect(monthly.resetsAt).toBe(monthlyReset)
  })

  it('testMissingOrMalformedResetIsInvalid', () => {
    const missingWeekly: JSONObject = {
      usage: {
        rolling: { percent: 0, resetsAt: '2027-01-15T13:00:00.000Z' },
        weekly: { percent: 0 },
        monthly: { percent: 0, resetsAt: '2027-02-10T08:00:00.000Z' }
      }
    }
    const malformedRolling: JSONObject = {
      usage: {
        rolling: { percent: 0, resetsAt: 'not-a-date' },
        weekly: { percent: 0, resetsAt: '2027-01-18T00:00:00.000Z' },
        monthly: { percent: 0, resetsAt: '2027-02-10T08:00:00.000Z' }
      }
    }
    for (const body of [missingWeekly, malformedRolling]) {
      expectInvalidResponse(() => OpenCodeUsageMapper.meterLines(body))
    }
  })

  it('testPercentIsClamped', () => {
    const body: JSONObject = {
      usage: {
        rolling: { percent: 150, resetsAt: '2026-07-12T13:30:00.662Z' },
        weekly: { percent: -4, resetsAt: '2026-07-13T00:00:00.662Z' },
        monthly: { percent: 35, resetsAt: '2026-08-04T11:18:32.662Z' }
      }
    }
    const lines = OpenCodeUsageMapper.meterLines(body)
    const rolling = progress(lines[0], 'expected progress lines')
    const weekly = progress(lines[1], 'expected progress lines')
    expect(rolling.used).toBe(100)
    expect(weekly.used).toBe(0)
  })

  it('testMissingUsageOrWindowIsInvalid', () => {
    expectInvalidResponse(() => OpenCodeUsageMapper.meterLines({}))
    expectInvalidResponse(() => OpenCodeUsageMapper.meterLines({ usage: { weekly: { percent: 1 } } }))
  })

  it('testErrorTypeFromDocumentedErrorBody', () => {
    const entitlement = '{"type":"error","error":{"type":"EntitlementError","message":"OpenCode Go subscription required."}}'
    const auth = '{"type":"error","error":{"type":"AuthError","message":"Unauthorized"}}'
    expect(OpenCodeUsageMapper.errorType(new HTTPResponse(403, {}, entitlement))).toBe('EntitlementError')
    expect(OpenCodeUsageMapper.errorType(new HTTPResponse(401, {}, auth))).toBe('AuthError')
    expect(OpenCodeUsageMapper.errorType(new HTTPResponse(403, {}, '<html>'))).toBeUndefined()
  })
})
