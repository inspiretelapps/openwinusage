import { describe, expect, it } from 'vitest'
import type { MetricLine } from '@core/models/MetricLine'
import { AntigravityUsageMapper } from '@core/providers/antigravity/AntigravityUsageMapper'

function used(line: MetricLine | undefined): number | undefined {
  return line?.type === 'progress' ? line.used : undefined
}

const completeJSON =
  '{"response":{"groups":[{"buckets":[{"bucketId":"gemini-5h","remainingFraction":1},{"bucketId":"gemini-weekly","remainingFraction":1},{"bucketId":"3p-5h","remainingFraction":1},{"bucketId":"3p-weekly","remainingFraction":1}]}]}}'

describe('AntigravityQuotaSummaryMergeTests', () => {
  it('testMergedSummariesTakeFirstUsableBucketPerID', () => {
    const first = '{"groups":[{"buckets":[{"bucketId":"gemini-5h"},{"bucketId":"3p-5h","remainingFraction":0.5}]}]}'
    const second = '{"groups":[{"buckets":[{"bucketId":"gemini-5h","remainingFraction":0.75},{"bucketId":"3p-5h","remainingFraction":0.1}]}]}'
    const lines = AntigravityUsageMapper.parseQuotaSummaries([first, 'not json', second])
    expect(lines?.map((line) => line.label)).toEqual(['Session', 'Claude'])
    expect(lines?.map((line) => used(line))).toEqual([25, 50])
    expect(AntigravityUsageMapper.parseQuotaSummaries(['{}'])).toBeUndefined()
  })

  it('testMergedSummariesTakeArgonFromTheFirstBodyThatHasIt', () => {
    const argon = (fraction: number): string =>
      `{"groups":[{"displayName":"Gemini 4 Argon","buckets":[{"bucketId":"gemini-argon-wtu-weekly","window":"weekly","remainingFraction":${fraction}}]}]}`
    const lines = AntigravityUsageMapper.parseQuotaSummaries([argon(0.6), argon(0.1)])
    // two hosts' Argon groups must not read as an ambiguous bucket
    expect(lines?.map((line) => line.label)).toEqual(['Argon Weekly'])
    expect(Math.abs((used(lines?.[0]) ?? -1) - 40)).toBeLessThanOrEqual(0.0001)
  })

  it('testIsCompleteSummaryNeedsAllFourUsableBuckets', () => {
    expect(AntigravityUsageMapper.isCompleteSummary(completeJSON)).toBe(true)
    const missingWeekly =
      '{"groups":[{"buckets":[{"bucketId":"gemini-5h","remainingFraction":1},{"bucketId":"3p-5h","remainingFraction":1},{"bucketId":"3p-weekly","remainingFraction":1}]}]}'
    expect(AntigravityUsageMapper.isCompleteSummary(missingWeekly)).toBe(false)
    const noFraction =
      '{"groups":[{"buckets":[{"bucketId":"gemini-5h","remainingFraction":1},{"bucketId":"gemini-weekly"},{"bucketId":"3p-5h","remainingFraction":1},{"bucketId":"3p-weekly","remainingFraction":1}]}]}'
    expect(AntigravityUsageMapper.isCompleteSummary(noFraction)).toBe(false)
    expect(AntigravityUsageMapper.isCompleteSummary('not json')).toBe(false)
    const weeklyInArgon =
      '{"groups":[{"buckets":[{"bucketId":"gemini-5h","remainingFraction":1},{"bucketId":"3p-5h","remainingFraction":1},{"bucketId":"3p-weekly","remainingFraction":1}]},{"displayName":"Gemini 4 Argon","buckets":[{"bucketId":"gemini-weekly","window":"weekly","remainingFraction":1}]}]}'
    // a shared bucket id inside the Argon group is not a usable shared-pool window
    expect(AntigravityUsageMapper.isCompleteSummary(weeklyInArgon)).toBe(false)
  })
})
