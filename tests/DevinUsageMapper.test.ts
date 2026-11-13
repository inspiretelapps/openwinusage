import { describe, it, expect } from 'vitest'
import { MetricLine } from '@core/models/MetricLine'
import { metricValue } from '@core/models/MetricValue'
import { DevinUsageMapper } from '@core/providers/devin/DevinUsageMapper'
import { ProviderError } from '@core/providers/ProviderError'
import type { ProviderUsage } from '@core/providers/ProviderRuntime'
import { describeError } from '@core/support/AppLog'
import { MetricPeriod } from '@core/support/MetricPeriod'
import { unix } from './TestSupport'

const dailyReset = unix(1_774_080_000)
const weeklyReset = unix(1_774_166_400)

function map(planStatus: string): ProviderUsage {
  return DevinUsageMapper.map(`{"userStatus":{"planStatus":${planStatus}}}`)
}

function thrown(body: () => unknown): unknown {
  try {
    body()
  } catch (error) {
    return error
  }
  throw new Error('expected a throw')
}

describe('DevinUsageMapperTests', () => {
  it('testMapsThePlanBothQuotasAsUsedAndTheBalanceInDollars', () => {
    const usage = map(`
        {"planInfo":{"planName":" Max ","billingStrategy":"BILLING_STRATEGY_QUOTA"},
         "dailyQuotaRemainingPercent":100,"weeklyQuotaRemainingPercent":40,"overageBalanceMicros":"964220000",
         "dailyQuotaResetAtUnix":"1774080000","weeklyQuotaResetAtUnix":"1774166400"}
        `)

    expect(usage.plan).toBe('Max')
    expect(usage.lines).toEqual([
      MetricLine.percent('Daily quota', 0, dailyReset, MetricPeriod.dayMs),
      MetricLine.percent('Weekly quota', 60, weeklyReset, MetricPeriod.weekMs),
      MetricLine.values('Extra usage balance', [metricValue(964.22, 'dollars')])
    ])
  })

  it('testAZeroOrNegativeBalanceReadsZeroDollars', () => {
    for (const micros of ['"0"', '"-44347"']) {
      const usage = map(`{"weeklyQuotaRemainingPercent":40,"overageBalanceMicros":${micros}}`)
      expect(usage.lines.at(-1), micros).toEqual(MetricLine.values('Extra usage balance', [metricValue(0, 'dollars')]))
    }
  })

  it('testAHiddenDailyQuotaFillsTheWeeklyRowWhenThereIsNoWeeklyQuota', () => {
    const usage = map(`
        {"planInfo":{"planName":"Pro","hideDailyQuota":true},"dailyQuotaRemainingPercent":30,"dailyQuotaResetAtUnix":"1774080000"}
        `)

    expect(usage.lines).toEqual([MetricLine.percent('Weekly quota', 70, undefined, MetricPeriod.weekMs)])
  })

  it('testAnOmittedWeeklyShareBesideAResetIsUsedUp', () => {
    for (const hideDailyQuota of [true, false]) {
      const usage = map(`
            {"planInfo":{"planName":"Max","hideDailyQuota":${hideDailyQuota}},
             "dailyQuotaRemainingPercent":100,"dailyQuotaResetAtUnix":"1774080000","weeklyQuotaResetAtUnix":"1774166400"}
            `)

      expect(
        usage.lines.find((line) => line.label === 'Weekly quota'),
        `hideDailyQuota ${hideDailyQuota}`
      ).toEqual(MetricLine.percent('Weekly quota', 100, weeklyReset, MetricPeriod.weekMs))
    }
  })

  it('testAnOmittedDailyShareBesideAResetIsUsedUp', () => {
    const usage = map('{"weeklyQuotaRemainingPercent":40,"dailyQuotaResetAtUnix":"1774080000"}')

    expect(usage.lines[0]).toEqual(MetricLine.percent('Daily quota', 100, dailyReset, MetricPeriod.dayMs))
  })

  it('testAnUnreadableShareIsAnInvalidResponseNotAUsedUpQuota', () => {
    for (const key of ['dailyQuotaRemainingPercent', 'weeklyQuotaRemainingPercent']) {
      for (const malformed of ['"abc"', 'true', '{}']) {
        const error = thrown(() =>
          map(`
                {"${key}":${malformed},"dailyQuotaResetAtUnix":"1774080000","weeklyQuotaResetAtUnix":"1774166400"}
                `)
        )
        expect(ProviderError.invalidResponse.equals(error), `${key}: ${malformed}`).toBe(true)
      }
    }
  })

  it('testAnAccountWithNoQuotaAndNoBalanceSaysSo', () => {
    const error = thrown(() => map('{"planInfo":{"planName":"Max"}}'))
    expect(describeError(error)).toBe('Devin reports no quota for this account.')
  })

  it('testABodyWithoutAUserStatusIsAnInvalidResponse', () => {
    const error = thrown(() => DevinUsageMapper.map('{"code":"internal"}'))
    expect(ProviderError.invalidResponse.equals(error)).toBe(true)
  })
})
