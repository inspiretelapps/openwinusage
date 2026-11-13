import { describe, it, expect } from 'vitest'
import { CopilotUsageMapper } from '@core/providers/copilot/CopilotUsageMapper'
import { GrokUsageMapper } from '@core/providers/grok/GrokUsageMapper'
import { HTTPResponse } from '@core/services/HTTPClient'

describe('RetainedProviderUsageTests', () => {
  it('testCopilotMapperUsesProviderReportedRemainingCredits', () => {
    const mapped = CopilotUsageMapper.mapBody({
      copilot_plan: 'pro',
      quota_snapshots: {
        premium_interactions: { entitlement: 100, remaining: 75 }
      }
    })

    expect(mapped.plan).toBe('Pro')
    const credits = mapped.lines.find((line) => line.label === 'Credits')
    if (credits?.type !== 'progress') throw new Error('expected Credits meter')
    expect(credits.used).toBe(25)
    expect(credits.limit).toBe(100)
  })

  it('testGrokMapperMapsWeeklyPoolAndPayAsYouGoCap', () => {
    const response = new HTTPResponse(
      200,
      {},
      '{"config":{"currentPeriod":{"type":"USAGE_PERIOD_TYPE_WEEKLY","start":"2026-07-03T04:01:09Z","end":"2026-07-10T04:01:09Z"},"creditUsagePercent":37.5,"onDemandCap":{"val":2500}}}'
    )

    const mapped = GrokUsageMapper.mapCreditsConfig(response)

    expect(mapped.lines.some((line) => line.label === 'Weekly limit')).toBe(true)
    const badge = mapped.lines.find((line) => line.label === 'Pay as you go')
    if (badge?.type !== 'badge') throw new Error('expected Pay as you go badge')
    expect(badge.text).toBe('2500 cap')
  })
})
