import { describe, expect, it } from 'vitest'
import { ProgressFormat, type MetricLine } from '@core/models/MetricLine'
import type { ProviderUsage } from '@core/providers/ProviderRuntime'
import { CursorPlanUsageFacts, CursorUsageMapper } from '@core/providers/cursor/CursorUsageMapper'
import type { JSONObject } from '@core/support/ProviderParse'

function map(plan: JSONObject): ProviderUsage {
  return CursorUsageMapper.mapUsage(
    {
      enabled: true,
      planUsage: plan,
      billingCycleStart: 1_770_000_000_000,
      billingCycleEnd: 1_772_592_000_000,
      spendLimitUsage: { limitType: 'team', pooledUsed: 0 }
    },
    'Team',
    undefined,
    0
  )
}

function line(mapped: ProviderUsage, label: string): MetricLine | undefined {
  return mapped.lines.find((line) => line.label === label)
}

function assertPercent(mapped: ProviderUsage, label: string, expected: number): void {
  const found = line(mapped, label)
  if (found?.type !== 'progress') throw new Error(`Missing ${label}`)
  expect(Math.abs(found.used - expected)).toBeLessThanOrEqual(0.000001)
  expect(found.limit).toBe(100)
  expect(found.format).toEqual(ProgressFormat.percent)
}

describe('CursorTeamPoolTests', () => {
  it('testReportedStandardSeatUsesStructuredTotalInsteadOfLegacyTwentyDollars', () => {
    const mapped = map({
      totalSpend: 1022,
      includedSpend: 1022,
      remaining: 978,
      limit: 2000,
      autoPercentUsed: 2.6476190476190475,
      apiPercentUsed: 11.65,
      totalPercentUsed: 4.088
    })
    assertPercent(mapped, 'Total usage', 4.088)
    assertPercent(mapped, 'Cursor Models', 2.6476190476190475)
    assertPercent(mapped, 'Other Models', 11.65)
  })

  it('testPremiumSeatWithoutTotalDoesNotInventDollarOrPercentageTotal', () => {
    const mapped = map({
      limit: 2000,
      totalSpend: 666,
      autoPercentUsed: 0.3728571428571429,
      apiPercentUsed: 2.025
    })
    expect(line(mapped, 'Total usage')).toBeUndefined()
    assertPercent(mapped, 'Cursor Models', 0.3728571428571429)
    assertPercent(mapped, 'Other Models', 2.025)
  })

  it('testPoolsWithoutLimitDoNotTriggerRequestFallback', () => {
    const usage: JSONObject = {
      enabled: true,
      planUsage: { autoPercentUsed: 0, apiPercentUsed: 0 },
      spendLimitUsage: { limitType: 'team' }
    }
    for (const name of ['Team', 'Enterprise', undefined]) {
      expect(CursorUsageMapper.shouldUseRequestBasedFallback(new CursorPlanUsageFacts(usage), name).shouldFallback).toBe(false)
    }
    expect(new CursorPlanUsageFacts(usage).shouldTryGenericRequestFallback).toBe(false)
    const mapped = CursorUsageMapper.mapUsage(usage, undefined, undefined, 0)
    assertPercent(mapped, 'Cursor Models', 0)
    assertPercent(mapped, 'Other Models', 0)
  })

  it('testABillingCycleTooLongForAnIntFallsBackToAMonth', () => {
    const mapped = CursorUsageMapper.mapUsage(
      {
        enabled: true,
        planUsage: { autoPercentUsed: 0, apiPercentUsed: 0 },
        billingCycleStart: 0,
        billingCycleEnd: 1e300
      },
      undefined,
      undefined,
      0
    )
    const found = line(mapped, 'Cursor Models')
    if (found?.type !== 'progress') throw new Error('expected Cursor Models')
    expect(found.periodDurationMs).toBe(CursorUsageMapper.billingPeriodMs)
  })

  it('testLegacyFiveThousandDollarPoolWithZeroPlaceholdersKeepsDollarMeter', () => {
    const mapped = map({
      limit: 500_000,
      totalSpend: 234_500,
      autoPercentUsed: 0,
      apiPercentUsed: 0,
      totalPercentUsed: 0
    })
    const found = line(mapped, 'Total usage')
    if (found?.type !== 'progress') throw new Error('Missing legacy total')
    expect(found.used).toBe(2345)
    expect(found.limit).toBe(5000)
    expect(found.format).toEqual(ProgressFormat.dollars)
  })

  it('testIncompleteOrMalformedPoolsKeepLegacyFallback', () => {
    const cases: JSONObject[] = [
      { autoPercentUsed: 1 },
      { autoPercentUsed: true, apiPercentUsed: 2 },
      { autoPercentUsed: -1, apiPercentUsed: 2 },
      { autoPercentUsed: Infinity, apiPercentUsed: 2 }
    ]
    for (const pools of cases) {
      const plan = { limit: 500_000, totalSpend: 234_500, ...pools }
      const mapped = map(plan)
      const found = line(mapped, 'Total usage')
      if (found?.type !== 'progress') throw new Error('Missing legacy total')
      expect(found.format).toEqual(ProgressFormat.dollars)
    }
  })

  it('testTeamNameAloneRecognizesPoolsAndPreservesExtraUsageAndCredits', () => {
    const mapped = CursorUsageMapper.mapUsage(
      {
        enabled: true,
        planUsage: { limit: 2000, autoPercentUsed: 0, apiPercentUsed: 12 },
        spendLimitUsage: { individualLimit: 5000, individualRemaining: 4000 }
      },
      ' Team ',
      undefined,
      1000
    )
    expect(line(mapped, 'Total usage')).toBeUndefined()
    expect(line(mapped, 'On-demand')).toBeDefined()
    expect(line(mapped, 'Credits')).toBeDefined()
  })
})
