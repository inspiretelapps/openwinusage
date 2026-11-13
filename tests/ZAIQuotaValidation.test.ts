import { describe, expect, it } from 'vitest'
import { ProviderError } from '@core/providers/ProviderError'
import { ZAIUsageMapper } from '@core/providers/zai/ZAIUsageMapper'

function thrown(body: () => unknown, message?: string): unknown {
  try {
    body()
  } catch (error) {
    return error
  }
  throw new Error(`expected a throw${message === undefined ? '' : `: ${message}`}`)
}

function expectProviderError(body: () => unknown, expected: ProviderError, message?: string): void {
  const error = thrown(body, message)
  expect(ProviderError.is(error) && error.equals(expected), message).toBe(true)
}

describe('ZAIQuotaValidationMapperTests', () => {
  it('testMissingRequiredValuesNeverBecomeZeroUsage', () => {
    const malformedLimits = [
      '{"data":{"limits":[{"type":"TOKENS_LIMIT","unit":3,"number":5}]}}',
      '{"data":{"limits":[{"type":"TOKENS_LIMIT","unit":3,"number":5,"percentage":true}]}}',
      '{"data":{"limits":[{"type":"TIME_LIMIT","usage":1000}]}}',
      '{"data":{"limits":[{"type":"TIME_LIMIT","currentValue":10}]}}',
      '{"data":{"limits":[{"type":"TIME_LIMIT","currentValue":-1,"usage":1000}]}}'
    ]

    for (const body of malformedLimits) {
      expectProviderError(() => ZAIUsageMapper.mapQuota(body), ProviderError.invalidResponse, body)
    }
  })

  it('testMalformedEnvelopeIsRejectedButExplicitEmptyLimitsRemainValid', () => {
    for (const body of ['not-json', '{"data":[]}', '{"data":{}}', '{"data":{"limits":{}}}']) {
      expectProviderError(() => ZAIUsageMapper.mapQuota(body), ProviderError.invalidResponse, body)
    }

    const lines = ZAIUsageMapper.mapQuota('{"data":{"limits":[]}}')
    expect(lines.length).toBe(0)
  })

  it('testAKeyWithNoCodingPlanSaysSoAndAnyOtherFailedBodyStaysInvalid', () => {
    const noPlan = '{"code":500,"msg":"当前用户不存在coding plan","success":false}'
    expectProviderError(
      () => ZAIUsageMapper.mapQuota(noPlan),
      ProviderError.unavailable('No active GLM Coding Plan. Subscribe at z.ai/subscribe to see usage.')
    )

    const other = '{"code":500,"msg":"internal error","success":false}'
    expectProviderError(() => ZAIUsageMapper.mapQuota(other), ProviderError.invalidResponse)
  })

  it('testAKeyZaiRefusesInsideAnOKResponseIsRejected', () => {
    const refused = '{"code":401,"msg":"token expired or incorrect","success":false}'
    expectProviderError(() => ZAIUsageMapper.mapQuota(refused), ProviderError.signInExpired('zai'))
  })

  it('testUnknownLimitsShowNothingAndDoNotHideKnownMeters', () => {
    const unknown = '{"type":"FUTURE_LIMIT"},{"type":"TOKENS_LIMIT","unit":99,"number":1,"percentage":70}'
    expect(ZAIUsageMapper.mapQuota(`{"data":{"limits":[${unknown}]}}`).length).toBe(0)

    const known = '{"type":"TOKENS_LIMIT","unit":3,"number":5,"percentage":25}'
    const lines = ZAIUsageMapper.mapQuota(`{"data":{"limits":[${unknown},${known}]}}`)

    expect(lines.find((line) => line.label === 'Session')).toBeDefined()
    expect(lines.find((line) => line.label === 'Weekly')).toBeUndefined()
  })
})
