import { describe, expect, it } from 'vitest'
import { MetricLine, ProgressFormat } from '@core/models/MetricLine'
import { AntigravityUsageMapper } from '@core/providers/antigravity/AntigravityUsageMapper'
import { MetricPeriod } from '@core/support/MetricPeriod'
import { OpenUsageISO8601 } from '@core/support/OpenUsageISO8601'

function summary(buckets: string, groupName = 'Gemini 4 Argon'): string {
  return `{"groups":[
  {"displayName":"${groupName}","buckets":[${buckets}]},
  {"displayName":"Gemini Models","buckets":[
    {"bucketId":"gemini-5h","remainingFraction":0.8},
    {"bucketId":"gemini-weekly","remainingFraction":0.7}
  ]},
  {"displayName":"Claude and GPT models","buckets":[
    {"bucketId":"3p-5h","remainingFraction":0.6},
    {"bucketId":"3p-weekly","remainingFraction":0.5}
  ]}
]}`
}

function assertSharedPoolsOnly(data: string): void {
  const lines = AntigravityUsageMapper.parseQuotaSummaries([data])
  expect(lines?.map((line) => line.label)).toEqual(['Session', 'Weekly', 'Claude', 'Claude Weekly'])
  const used = lines?.map((metric) => (metric.type === 'progress' ? metric.used : undefined))
  expect(used?.length).toBe(4)
  const expected = [20.0, 30, 40, 50]
  for (const [index, actual] of (used ?? []).entries()) {
    expect(Math.abs((actual ?? -1) - expected[index])).toBeLessThanOrEqual(0.0001)
  }
}

describe('AntigravityArgonQuotaTests', () => {
  it('testUnavailableArgonPreservesSharedQuotas', () => {
    const unavailable = [
      '',
      '{"bucketId":"test-id","window":"weekly"}',
      '{"bucketId":"test-id","window":"weekly","remainingFraction":"unknown"}',
      '{"bucketId":"test-id","window":"weekly","remainingFraction":1,"disabled":true}',
      '{"bucketId":"test-id","window":"weekly","remainingAmount":100}'
    ]
    for (const buckets of unavailable) {
      assertSharedPoolsOnly(summary(buckets))
    }
  })

  it('testOnlyExplicitArgonWeeklyGroupCanPopulateTheRow', () => {
    for (const group of ['Gemini Models', 'Gemini 4 Argon Images', 'Future Models']) {
      assertSharedPoolsOnly(
        summary('{"bucketId":"test-id","displayName":"Gemini 4 Argon Weekly Limit","window":"weekly","remainingFraction":0.1}', group)
      )
    }
    for (const buckets of [
      '{"bucketId":"test-id","displayName":"Gemini 4 Argon Weekly Limit","remainingFraction":0.1}',
      '{"bucketId":"test-id","window":"5h","remainingFraction":0.1}',
      '{"window":"weekly","remainingFraction":0.1}',
      '{"bucketId":"","window":"weekly","remainingFraction":0.1}',
      '{"bucketId":"gemini-weekly","window":"weekly","remainingFraction":0.1}'
    ]) {
      assertSharedPoolsOnly(summary(buckets))
    }
  })

  it('testDisabledFlagRejectsMalformedValuesButAllowsOmissionNullAndFalse', () => {
    for (const value of ['true', '"true"', '"false"', '1', '0']) {
      assertSharedPoolsOnly(summary(`{"bucketId":"test-id","window":"weekly","remainingFraction":0.5,"disabled":${value}}`))
    }

    for (const field of ['', ', "disabled":null', ', "disabled":false']) {
      const lines = AntigravityUsageMapper.parseQuotaSummaries([summary(`{"bucketId":"test-id","window":"weekly","remainingFraction":0.5${field}}`)])
      // disabled field: ${field}
      expect(lines?.find((line) => line.label === 'Argon Weekly')).toEqual(
        MetricLine.progress('Argon Weekly', 50, 100, ProgressFormat.percent, undefined, MetricPeriod.weekMs)
      )
    }
  })

  it('testAmbiguousWeeklyBucketsDoNotChooseOrMergeAQuota', () => {
    assertSharedPoolsOnly(
      summary(`{"bucketId":"test-first","window":"weekly","remainingFraction":0.9},
{"bucketId":"test-second","window":"weekly","remainingFraction":0.1}`)
    )
  })

  it('testArgonFiveHourBucketDoesNotOverrideItsWeeklyQuota', () => {
    const lines = AntigravityUsageMapper.parseQuotaSummaries([
      summary(`{"bucketId":"test-session","window":"5h","remainingFraction":0},
{"bucketId":"test-weekly","window":"weekly","remainingFraction":0.5}`)
    ])
    expect(lines?.map((line) => line.label)).toEqual(['Session', 'Weekly', 'Argon Weekly', 'Claude', 'Claude Weekly'])
    expect(lines?.find((line) => line.label === 'Argon Weekly')).toEqual(
      MetricLine.progress('Argon Weekly', 50, 100, ProgressFormat.percent, undefined, MetricPeriod.weekMs)
    )
  })

  it('testArgonOnlySummaryUsesWeeklyPeriodAndPreservesZeroRemaining', () => {
    const data =
      '{"groups":[{"displayName":"Gemini 4 Argon","buckets":[{"bucketId":"test-id","window":"weekly","remainingFraction":0,"disabled":false}]}]}'
    const lines = AntigravityUsageMapper.parseQuotaSummaries([data])
    expect(lines?.length).toBe(1)
    expect(lines?.[0]).toEqual(MetricLine.progress('Argon Weekly', 100, 100, ProgressFormat.percent, undefined, MetricPeriod.weekMs))
  })

  it('testArgonWTUWeeklyBucketParsesBareAndWrapped', () => {
    const group = `{"displayName":"Gemini 4 Argon",
 "description":"For paid Pro plans, Argon quota is separate. Higher Argon quota (included as part of the larger Gemini quota bucket) is available on Ultra plans.",
 "buckets":[{"bucketId":"gemini-argon-wtu-weekly","displayName":"Gemini 4 Argon Weekly Limit",
             "window":"weekly","remainingFraction":1.0,"resetTime":"2026-10-22T23:24:33Z"}]}`
    const reset = OpenUsageISO8601.date('2026-10-22T23:24:33Z')
    expect(reset).toBeDefined()
    const expected = MetricLine.progress('Argon Weekly', 0, 100, ProgressFormat.percent, reset, MetricPeriod.weekMs)
    for (const json of [`{"groups":[${group}]}`, `{"response":{"groups":[${group}]}}`]) {
      expect(AntigravityUsageMapper.parseQuotaSummaries([json])).toEqual([expected])
    }
  })

  it('testMalformedGroupNameDoesNotInvalidateSharedBuckets', () => {
    const data = '{"groups":[{"displayName":42,"buckets":[{"bucketId":"gemini-5h","remainingFraction":0.8}]}]}'
    const lines = AntigravityUsageMapper.parseQuotaSummaries([data])
    expect(lines?.map((line) => line.label)).toEqual(['Session'])
  })
})
