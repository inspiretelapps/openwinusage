import { describe, expect, it } from 'vitest'
import { ProgressFormat } from '@core/models/MetricLine'
import { CursorUsageSummaryMapper } from '@core/providers/cursor/CursorUsageSummaryMapper'

describe('CursorUsageSummaryMapperTests', () => {
  it('testMapsProviderReturnedOnDemandDollars', () => {
    const mapped = CursorUsageSummaryMapper.map(
      {
        membershipType: 'enterprise',
        individualUsage: {
          plan: { enabled: true, limit: 0, totalPercentUsed: 6.25 },
          onDemand: { enabled: true, used: 12_345, limit: 200_000 }
        }
      },
      undefined,
      'Enterprise',
      'unavailable'
    )

    expect(mapped.plan).toBe('Enterprise')
    const onDemand = mapped.lines.find((line) => line.label === 'On-demand')
    if (onDemand?.type !== 'progress') throw new Error('expected On-demand meter')
    expect(onDemand.used).toBe(123.45)
    expect(onDemand.limit).toBe(2_000)
    expect(onDemand.format).toEqual(ProgressFormat.dollars)
  })

  it('testRejectsResponseWithoutUsableMetrics', () => {
    expect(() => CursorUsageSummaryMapper.map({ individualUsage: { plan: { limit: 0 } } }, undefined, undefined, 'unavailable')).toThrow()
  })
})
