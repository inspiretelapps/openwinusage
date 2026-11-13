import { describe, it, expect } from 'vitest'
import { GrokCreditsConfigDecoder } from '@core/providers/grok/GrokCreditsConfigDecoder'
import { ProviderError } from '@core/providers/ProviderError'

/** `absent` leaves the field out of the body, the way proto-JSON omits a zero. */
const absent = Symbol('absent')

function responseBody(
  fields: { percent?: unknown; onDemandCap?: unknown; start?: string; end?: string } = {}
): string {
  const {
    percent = 99.0,
    onDemandCap = 2500,
    start = '2026-06-30T21:36:52.140114+00:00',
    end = '2026-07-07T21:36:52.140114+00:00'
  } = fields
  const config: Record<string, unknown> = { currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', start, end } }
  if (percent !== absent) config.creditUsagePercent = percent
  if (onDemandCap !== absent) config.onDemandCap = { val: onDemandCap }
  return JSON.stringify({ config })
}

function thrown(body: () => unknown): unknown {
  try {
    body()
  } catch (error) {
    return error
  }
  throw new Error('expected a throw')
}

/**
 * Grok's credits config is proto-JSON, so a zero-valued field is omitted rather than written; the
 * decoder reads an absent percent or cap as 0 and a present but malformed one, a period that does
 * not move forward, or a body without the config as `ProviderError.invalidResponse`.
 */
describe('GrokCreditsConfigDecoderTests', () => {
  it('testAbsentZeroValuedFieldsDecodeAsZero', () => {
    expect(GrokCreditsConfigDecoder.decode(responseBody({ percent: absent })).usedPercent).toBe(0)
    expect(GrokCreditsConfigDecoder.decode(responseBody({ onDemandCap: absent })).onDemandCap).toBe(0)
  })

  it('testRejectsNonNumericFields', () => {
    for (const body of [responseBody({ percent: 'high' }), responseBody({ onDemandCap: 'lots' })]) {
      const error = thrown(() => GrokCreditsConfigDecoder.decode(body))
      expect(ProviderError.invalidResponse.equals(error), body).toBe(true)
    }
  })

  it('testRejectsPeriodThatDoesNotMoveForward', () => {
    const reversed = responseBody({ start: '2026-07-07T21:36:52.140114+00:00', end: '2026-06-30T21:36:52.140114+00:00' })
    const error = thrown(() => GrokCreditsConfigDecoder.decode(reversed))
    expect(ProviderError.invalidResponse.equals(error)).toBe(true)
  })

  it('testRejectsMissingConfigFields', () => {
    for (const body of ['{}', '{"config":{}}', '{"config":{"currentPeriod":{}}}', 'not json']) {
      const error = thrown(() => GrokCreditsConfigDecoder.decode(body))
      expect(ProviderError.invalidResponse.equals(error), body).toBe(true)
    }
  })
})
