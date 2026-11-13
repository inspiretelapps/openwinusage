import { describe, expect, it } from 'vitest'
import { MetricLine, ProgressFormat } from '@core/models/MetricLine'
import { metricValue } from '@core/models/MetricValue'
import { UsageTotals, UsageWindow } from '@core/models/UsageHistory'
import { OpenRouterUsageMapper } from '@core/providers/openrouter/OpenRouterUsageMapper'
import { ProviderError } from '@core/providers/ProviderError'
import { OpenRouterFixtures } from './OpenRouterFixtures'
import { iso } from './TestSupport'

const thursday = iso('2026-10-29T11:00:00Z')

function keyLimit(fields: string): MetricLine | undefined {
  const text = '{"data":{"is_management_key":false,"usage_daily":0,"usage_weekly":0,"usage_monthly":0,' + fields + '}}'
  return OpenRouterUsageMapper.key(text, thursday).lines.find((line) => line.label === 'Key Limit')
}

function thrown(body: () => unknown, message?: string): unknown {
  try {
    body()
  } catch (error) {
    return error
  }
  throw new Error(`expected a throw${message === undefined ? '' : `: ${message}`}`)
}

describe('OpenRouterUsageMapperTests', () => {
  it('testAKeyResponseMissingWhatTheCardNeedsIsInvalid', () => {
    const malformed = [
      '{"data":{"usage_daily":1.5,"usage_weekly":4,"usage_monthly":12}}',
      '{"data":{"is_management_key":false,"usage_daily":1.5,"usage_weekly":4}}',
      '{"data":{"is_management_key":false,"usage_daily":1.5,"usage_weekly":4,"usage_monthly":12,"limit":10,"limit_remaining":null}}',
      '{"error":{"code":500,"message":"Internal Server Error"}}'
    ]
    for (const text of malformed) {
      const error = thrown(() => OpenRouterUsageMapper.key(text), text)
      expect(ProviderError.is(error) && error.equals(ProviderError.invalidResponse), text).toBe(true)
    }
  })

  it('testAKeyLimitWithoutAResetHasNoResetAndNoLimitHasNoRow', () => {
    expect(keyLimit('"limit":10,"limit_remaining":7.5,"limit_reset":null')).toEqual(
      MetricLine.progress('Key Limit', 2.5, 10, ProgressFormat.dollars, undefined, undefined)
    )
    expect(keyLimit('"limit":null,"limit_remaining":null,"limit_reset":null')).toBeUndefined()
  })

  /** `total_credits` is every credit ever bought, not a limit, so the credits show as a balance and never as a meter. */
  it('testCreditsShowOnlyTheBalance', () => {
    expect(OpenRouterUsageMapper.creditsLines('{"data":{"total_credits":10,"total_usage":12.5}}')).toEqual([
      MetricLine.values('Balance', [metricValue(0, 'dollars')])
    ])
    expect(() => OpenRouterUsageMapper.creditsLines('{"data":{"total_credits":100}}')).toThrow()
  })

  it('testAKeysPageMustBeAListOfKeysWithTheirSpend', () => {
    const spend = new Map<string, UsageTotals>([
      [UsageWindow.key(UsageWindow.today), UsageTotals.make({ spend: 0.25, byokSpend: 0 })],
      [UsageWindow.key(UsageWindow.thisWeek), UsageTotals.make({ spend: 0.5, byokSpend: 0 })],
      [UsageWindow.key(UsageWindow.thisMonth), UsageTotals.make({ spend: 1, byokSpend: 0 })]
    ])
    expect(OpenRouterUsageMapper.keysPage(OpenRouterFixtures.keysPage(2, 0.25, 0.5, 1))).toEqual([spend, spend])
    expect(OpenRouterUsageMapper.keysPage('{"data":[]}')).toEqual([])
    for (const text of ['{"data":{"usage_daily":1}}', '{"data":[{"hash":"abc","usage_daily":1,"usage_weekly":2}]}']) {
      expect(() => OpenRouterUsageMapper.keysPage(text), text).toThrow()
    }
  })

  it('testActivitySumsRowsPerUTCDayAndModelAndAMalformedRowRejectsTheRead', () => {
    const rows = `
        {"data":[{"date":"2026-10-28","model":"a","usage":1,"requests":2,"prompt_tokens":10,"completion_tokens":5},
        {"date":"2026-10-28","model":"a","usage":0.5,"requests":1,"prompt_tokens":4,"completion_tokens":1,"cached_tokens":2,"reasoning_tokens":null}]}
        `
    const day = OpenRouterUsageMapper.activityDays(rows)?.get(iso('2026-10-28T00:00:00Z'))
    if (day === undefined) throw new Error('the day was not read')

    // a measure one row leaves out still counts from the rows that have it
    expect(day.totals.values).toEqual({ spend: 1.5, tokens: 20, inputTokens: 12, outputTokens: 6, cacheReadTokens: 2, reasoningTokens: 0, byokSpend: 0 })
    expect(day.byModel?.a?.values.tokens).toBe(20)
    for (const text of [
      '{"data":{"date":"2026-10-28"}}',
      '{"data":[{"date":"2026-10-28","model":"a","usage":1,"prompt_tokens":10}]}',
      '{"data":[{"date":"2026-10-28","model":"a","usage":-1,"requests":1,"prompt_tokens":10,"completion_tokens":5}]}',
      '{"data":[{"date":"yesterday","model":"a","usage":1,"requests":1,"prompt_tokens":10,"completion_tokens":5}]}'
    ]) {
      expect(OpenRouterUsageMapper.activityDays(text), text).toBeUndefined()
    }
  })
})
