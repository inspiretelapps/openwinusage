import { describe, expect, it } from 'vitest'
import type { MetricLine } from '@core/models/MetricLine'
import { NetworkError } from '@core/models/ProviderSnapshot'
import { AntigravityMetric } from '@core/providers/antigravity/AntigravityMetric'
import { AntigravityUsageClient, AntigravityUsageClientTokenRefused } from '@core/providers/antigravity/AntigravityUsageClient'
import { AntigravityUsageMapper } from '@core/providers/antigravity/AntigravityUsageMapper'
import { HTTPResponse } from '@core/services/HTTPClient'
import { OpenUsageISO8601 } from '@core/support/OpenUsageISO8601'
import { bodyText, ProviderParse } from '@core/support/ProviderParse'
import type { Instant } from '@core/support/time'
import { jsonResponse, RoutingHTTPClient } from './TestSupport'

const dailyHost = 'daily-cloudcode-pa.googleapis.com'
const productionHost = 'cloudcode-pa.googleapis.com'

function bucket(id: string, fraction?: number, reset?: string): string {
  const fields = [`"bucketId":"${id}"`]
  if (fraction !== undefined) fields.push(`"remainingFraction":${fraction}`)
  if (reset !== undefined) fields.push(`"resetTime":"${reset}"`)
  return `{${fields.join(',')}}`
}

function summary(buckets: string[]): string {
  return `{"groups":[{"displayName":"fake","buckets":[${buckets.join(',')}]}]}`
}

const dailySummary = summary([
  bucket('gemini-5h', 0.99965, '2027-03-02T14:00:00Z'),
  bucket('gemini-weekly', 0.9742, '2027-03-08T09:00:00Z'),
  bucket('3p-5h', 0.5, '2027-03-02T15:00:00Z'),
  bucket('3p-weekly', 0.4, '2027-03-08T09:00:00Z')
])

const productionSummary = summary([
  bucket('gemini-5h', 1, '2027-03-02T19:00:00Z'),
  bucket('gemini-weekly', 1, '2027-03-09T00:00:00Z'),
  bucket('3p-5h', 0.9, '2027-03-02T19:00:00Z'),
  bucket('3p-weekly', 0.8, '2027-03-09T00:00:00Z')
])

function progress(line: MetricLine | undefined): { used: number; reset: Instant | undefined } {
  if (line?.type !== 'progress') throw new Error('expected a progress line')
  return { used: line.used, reset: line.resetsAt }
}

function expectClose(actual: number, expected: number, accuracy: number): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(accuracy)
}

function client(daily: HTTPResponse | undefined, production: HTTPResponse | undefined): { client: AntigravityUsageClient; http: RoutingHTTPClient } {
  const http = new RoutingHTTPClient((request) => {
    switch (new URL(request.url).host) {
      case dailyHost:
        if (!daily) throw new NetworkError()
        return daily
      case productionHost:
        if (!production) throw new NetworkError()
        return production
      default:
        return new HTTPResponse(404, {}, new Uint8Array())
    }
  })
  return { client: new AntigravityUsageClient(http), http }
}

function quotaHosts(http: RoutingHTTPClient): string[] {
  return http.requests
    .filter((request) => new URL(request.url).pathname === AntigravityUsageClient.quotaSummaryPath)
    .map((request) => new URL(request.url).host)
}

describe('AntigravityUsageClientTests', () => {
  it('testACompleteDailySummaryAnswersWithoutAskingProduction', async () => {
    const { client: usageClient, http } = client(jsonResponse(dailySummary), jsonResponse(productionSummary))

    const bodies = await usageClient.quotaSummary('access', 'fake-project')

    expect(bodies.length).toBe(1)
    expect(quotaHosts(http)).toEqual([dailyHost])
    const lines = AntigravityUsageMapper.parseQuotaSummaries(bodies)
    if (!lines) throw new Error('expected lines')
    const session = progress(lines.find((line) => line.label === AntigravityMetric.sessionLabel))
    expectClose(session.used, 0.035, 0.001)
    expect(session.reset).toBe(OpenUsageISO8601.date('2027-03-02T14:00:00Z'))
    const weekly = progress(lines.find((line) => line.label === AntigravityMetric.weeklyLabel))
    expectClose(weekly.used, 2.58, 0.0001)
    expect(weekly.reset).toBe(OpenUsageISO8601.date('2027-03-08T09:00:00Z'))
  })

  it('testDailyWinsPerBucketAndProductionFillsOmissions', async () => {
    const daily = summary([bucket('3p-5h', 0.6, '2027-03-02T10:00:00Z')])
    const { client: usageClient, http } = client(jsonResponse(daily), jsonResponse(productionSummary))

    const bodies = await usageClient.quotaSummary('access', 'fake-project')
    const lines = AntigravityUsageMapper.parseQuotaSummaries(bodies)
    if (!lines) throw new Error('expected lines')

    expect(quotaHosts(http)).toEqual([dailyHost, productionHost])
    for (const label of [AntigravityMetric.sessionLabel, AntigravityMetric.weeklyLabel]) {
      // comes from production
      const line = progress(lines.find((line) => line.label === label))
      expectClose(line.used, 0, 0.0001)
    }
    const claude = progress(lines.find((line) => line.label === AntigravityMetric.claudeLabel))
    expectClose(claude.used, 40, 0.001)
    expect(claude.reset).toBe(OpenUsageISO8601.date('2027-03-02T10:00:00Z'))
    const claudeWeekly = progress(lines.find((line) => line.label === AntigravityMetric.claudeWeeklyLabel))
    expectClose(claudeWeekly.used, 20, 0.001)
  })

  it('testAnUnusableDailyFractionFillsFromProduction', async () => {
    const daily = summary([bucket('gemini-5h'), bucket('3p-5h', 0.5, '2027-03-02T10:00:00Z')])
    const { client: usageClient } = client(jsonResponse(daily), jsonResponse(productionSummary))

    const bodies = await usageClient.quotaSummary('access', undefined)
    const lines = AntigravityUsageMapper.parseQuotaSummaries(bodies)
    if (!lines) throw new Error('expected lines')

    const session = progress(lines.find((line) => line.label === AntigravityMetric.sessionLabel))
    expectClose(session.used, 0, 0.0001)
    expect(session.reset).toBe(OpenUsageISO8601.date('2027-03-02T19:00:00Z'))
  })

  it('testDailyServerErrorAndTransportErrorFallBackToProduction', async () => {
    for (const daily of [jsonResponse('{}', 503), undefined]) {
      const { client: usageClient, http } = client(daily, jsonResponse(productionSummary))

      const bodies = await usageClient.quotaSummary('access', undefined)

      expect(quotaHosts(http)).toEqual([dailyHost, productionHost])
      expect(bodies.map(bodyText)).toEqual([productionSummary])
    }
  })

  it('testDailyUnauthorizedStillSucceedsOnProduction', async () => {
    const { client: usageClient } = client(jsonResponse('{"error":{"code":401}}', 401), jsonResponse(productionSummary))

    const bodies = await usageClient.quotaSummary('access', undefined)

    expect(bodies.map(bodyText)).toEqual([productionSummary])
  })

  it('testBothBasesUnauthorizedIsTokenRefused', async () => {
    const { client: usageClient } = client(jsonResponse('{"error":{"code":401}}', 401), jsonResponse('{"error":{"code":401}}', 401))

    await expect(usageClient.quotaSummary('access', undefined)).rejects.toBeInstanceOf(AntigravityUsageClientTokenRefused)
  })

  it('testQuotaRequestsCarryTheProjectAndBearerToken', async () => {
    const { client: usageClient, http } = client(jsonResponse(dailySummary), undefined)

    await usageClient.quotaSummary('access', 'fake-project-123')

    const request = http.requests[0]
    expect(request).toBeDefined()
    expect(request.headers?.Authorization).toBe('Bearer access')
    expect(request.body === undefined ? undefined : ProviderParse.jsonObject(request.body)?.project).toBe('fake-project-123')
  })

  it('testLoadCodeAssistStillAsksProductionFirst', async () => {
    const { client: usageClient, http } = client(jsonResponse('{"cloudaicompanionProject":"fake-project"}'), jsonResponse('{}', 503))

    await usageClient.loadCodeAssist('access')

    expect(http.requests.map((request) => new URL(request.url).host)).toEqual([productionHost, dailyHost])
  })
})
