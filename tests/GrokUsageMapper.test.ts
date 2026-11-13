import { describe, it, expect } from 'vitest'
import { GrokUsageMapper } from '@core/providers/grok/GrokUsageMapper'
import { ProviderError } from '@core/providers/ProviderError'
import { HTTPResponse } from '@core/services/HTTPClient'

function thrown(body: () => unknown): unknown {
  try {
    body()
  } catch (error) {
    return error
  }
  throw new Error('expected a throw')
}

describe('GrokUsageMapperTests', () => {
  it('testA412OtherThanTheTeamPrincipalsRefusalIsARequestFailure', () => {
    const other = new HTTPResponse(412, {}, '{"error":"precondition failed"}')
    const error = thrown(() => GrokUsageMapper.mapCreditsConfig(other))
    expect(ProviderError.requestFailed(412).equals(error)).toBe(true)
  })

  it('testAPayAsYouGoCapTooLargeForAnIntIsAnInvalidResponse', () => {
    const body = `
        {"config":{"currentPeriod":{"type":"USAGE_PERIOD_TYPE_WEEKLY","start":"2026-06-30T21:36:52Z",
         "end":"2026-07-07T21:36:52Z"},"onDemandCap":{"val":1e300}}}
        `
    const error = thrown(() => GrokUsageMapper.mapCreditsConfig(new HTTPResponse(200, {}, body)))
    expect(ProviderError.invalidResponse.equals(error)).toBe(true)
  })
})
