import { describe, expect, it } from 'vitest'
import type { MetricLine } from '@core/models/MetricLine'
import { ZAIUsageMapper } from '@core/providers/zai/ZAIUsageMapper'

const liveQuota = `
    {"code":200,"msg":"Operation successful","data":{"limits":[
      {"type":"TOKENS_LIMIT","unit":3,"number":5,"percentage":17,"nextResetTime":1782724971179},
      {"type":"TOKENS_LIMIT","unit":6,"number":1,"percentage":3,"nextResetTime":1783305486997},
      {"type":"TIME_LIMIT","unit":5,"number":1,"usage":1000,"currentValue":0,"remaining":1000,"percentage":0,"nextResetTime":1785292686976,"usageDetails":[{"modelCode":"search-prime","usage":0},{"modelCode":"web-reader","usage":0},{"modelCode":"zread","usage":0}]}
    ],"level":"pro"},"success":true}
    `

// Captured from a GLM Coding Lite plan on 2026-08-13. Z.ai renamed the percentage quota type
// from TOKENS_LIMIT to CREDIT_LIMIT and no longer includes reset time for the active 5-hour window.
const liveCreditQuota = `
    {"code":200,"msg":"Operation successful","data":{"limits":[
      {"type":"CREDIT_LIMIT","unit":3,"number":5,"usage":2000,"currentValue":0,"remaining":2000,"percentage":0},
      {"type":"CREDIT_LIMIT","unit":6,"number":1,"usage":10000,"currentValue":9855,"remaining":145,"percentage":98,"nextResetTime":1786685679998}
    ],"level":"lite"},"success":true}
    `

const liveSubscription = `
    {"code":200,"msg":"Operation successful","data":[{"productName":"GLM Coding Pro","status":"VALID","nextRenewTime":"2026-07-29","billingCycle":"monthly","inCurrentPeriod":true}],"success":true}
    `

function progress(lines: MetricLine[], label: string): { used: number; limit: number; periodDurationMs: number | undefined } | undefined {
  const line = lines.find((candidate) => candidate.label === label)
  if (line?.type !== 'progress') return undefined
  return { used: line.used, limit: line.limit, periodDurationMs: line.periodDurationMs }
}

describe('ZAILiveResponseMappingTests', () => {
  it('testMapsLiveResponseToSessionWeeklyAndWebSearches', () => {
    const mapped = ZAIUsageMapper.map(liveQuota, liveSubscription)

    expect(mapped.plan).toBe('GLM Coding Pro')

    const session = progress(mapped.lines, 'Session')
    expect(session).toBeDefined()
    expect(session?.used).toBeCloseTo(17, 3)
    expect(session?.periodDurationMs).toBe(5 * 60 * 60 * 1000)

    const weekly = progress(mapped.lines, 'Weekly')
    expect(weekly).toBeDefined()
    expect(weekly?.used).toBeCloseTo(3, 3)
    expect(weekly?.periodDurationMs).toBe(7 * 24 * 60 * 60 * 1000)

    const web = progress(mapped.lines, 'Web Searches')
    expect(web).toBeDefined()
    expect(web?.used).toBeCloseTo(0, 3)
    expect(web?.limit).toBeCloseTo(1000, 3)
  })

  it('testMapsCurrentCreditLimitResponseToSessionAndWeekly', () => {
    const mapped = ZAIUsageMapper.map(liveCreditQuota, undefined)

    const session = progress(mapped.lines, 'Session')
    expect(session).toBeDefined()
    expect(session?.used).toBeCloseTo(0, 3)
    expect(session?.periodDurationMs).toBe(5 * 60 * 60 * 1000)

    const weekly = progress(mapped.lines, 'Weekly')
    expect(weekly).toBeDefined()
    expect(weekly?.used).toBeCloseTo(98, 3)
    expect(weekly?.periodDurationMs).toBe(7 * 24 * 60 * 60 * 1000)
  })
})
