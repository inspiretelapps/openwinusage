import { describe, expect, it } from 'vitest'
import { Account, AccountCredential } from '@core/models/Account'
import { UsageHistory, UsageTotals, type UsageDay } from '@core/models/UsageHistory'
import { AccountProviderRuntime } from '@core/providers/AccountProviderRuntime'
import { OllamaHistorySource } from '@core/providers/ollama/OllamaHistorySource'
import { OllamaUsageClient } from '@core/providers/ollama/OllamaUsageClient'
import { HTTPResponse, type HTTPRequest } from '@core/services/HTTPClient'
import { Calendar } from '@core/support/Calendar'
import { OpenUsageISO8601 } from '@core/support/OpenUsageISO8601'
import { addSeconds, type Instant } from '@core/support/time'
import { InMemoryCredentialVault, jsonResponse, RoutingHTTPClient, TestClock, TestSwitch, unix } from './TestSupport'

/** 20:30 UTC on 30 October, already 31 October in Dubai, so rows read on the local clock would miss. */
const now = unix(1_793_392_200)
const utcToday = 1_793_318_400
const balance = '{"included":{"balance_usd":72.5,"allowance_usd":100}}'

/** `ISO8601DateFormatter().string(from:)`: internet date-time without fractional seconds. */
function isoString(instant: Instant): string {
  return new Date(instant).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/**
 * A day of 4 requests worth $0.25 over two models, today twice that so far, a quiet yesterday, and a
 * costly day 30 days back that Last 30 Days leaves out. A legacy plan reports request counts only.
 */
function usage(request: HTTPRequest, legacy: boolean): HTTPResponse {
  const range = new URL(request.url).searchParams.get('range') ?? '7d'
  const days = range === '30d' ? 30 : 7
  const metrics = (scale: number, parts: { requests: number; usd: number; input: number; cached: number; output: number }): string => {
    const requests = `"request_count":${parts.requests * scale}`
    if (legacy) return requests
    return (
      requests +
      `,"usage_usd":${parts.usd * scale},"input_tokens":${parts.input * scale},` +
      `"cached_input_tokens":${parts.cached * scale},"output_tokens":${parts.output * scale}`
    )
  }
  const scales: Record<number, number> = { 0: 2, 1: 0, 30: 400 }
  const buckets: string[] = []
  for (let daysAgo = days; daysAgo >= 0; daysAgo--) {
    const scale = scales[daysAgo] ?? 1
    const from = unix(utcToday - daysAgo * 86_400)
    const until = daysAgo === 0 ? now : addSeconds(from, 86_400)
    const groups =
      scale === 0
        ? ''
        : `{"model":"glm-5.3-flash",${metrics(scale, { requests: 3, usd: 0.2, input: 2_500, cached: 1_000, output: 200 })}},` +
          `{"model":"gpt-oss:120b",${metrics(scale, { requests: 1, usd: 0.05, input: 500, cached: 0, output: 100 })}}`
    buckets.push(
      `{"from":"${isoString(from)}","until":"${isoString(until)}",${daysAgo === 0 ? '"partial":true,' : ''}` +
        `${metrics(scale, { requests: 4, usd: 0.25, input: 3_000, cached: 1_000, output: 300 })},"groups":[${groups}]}`
    )
  }
  const start = isoString(unix(utcToday - days * 86_400))
  const body =
    `{"range":"${range}","scope":"self","granularity":"day","group_by":"model","from":"${start}",` +
    `"until":"${isoString(now)}","totals":{"request_count":0},"buckets":[${buckets.join(',')}]}`
  return new HTTPResponse(200, {}, body)
}

/**
 * Upstream's `makeAccount` also returns the `WidgetDataStore` that shows the runtime. The store is not
 * ported yet, so only the tests that need no store run; this is kept for the ones marked todo below.
 */
function makeAccount(
  status: TestSwitch<number | undefined> = new TestSwitch<number | undefined>(undefined),
  legacy = false
): { runtime: AccountProviderRuntime; http: RoutingHTTPClient; clock: TestClock } {
  const account = Account.make({ kind: 'ollama', label: 'Ollama' })
  const vault = new InMemoryCredentialVault()
  vault.save(AccountCredential.apiKey('ollama-key'), account.id)
  const clock = new TestClock(now)
  const http = new RoutingHTTPClient((request) => {
    switch (new URL(request.url).pathname) {
      case OllamaUsageClient.balancePath:
        return new HTTPResponse(200, {}, balance)
      case OllamaUsageClient.usagePath:
        if (status.value !== undefined) return new HTTPResponse(status.value, {}, new Uint8Array())
        return usage(request, legacy)
      default:
        return new HTTPResponse(200, {}, '{"Plan":"pro"}')
    }
  })
  const runtime = new AccountProviderRuntime(account, vault, http, clock.now)
  return { runtime, http, clock }
}

describe('OllamaUsageHistoryTests', () => {
  // These read the rows through `WidgetDataStore` (Stores), which is not ported yet.
  it.todo('testTheRowsShowWhatOllamaReportedForEachUTCDayAndTokensCountCachedInputOnce')
  it.todo('testTodayAndYesterdayAreReadAgainHourlyFromTheLastSevenDaysAndOnCommandR')
  it.todo('testALegacyPlanThatReportsOnlyRequestsShowsItsRequestsAndZeroRanges')
  it.todo('testAFailedReadZeroesTheRangesKeepsTheCardAndWaitsAnHour')
  it.todo('testEachWindowRowHasABreakdownOnUTCDaysAndTheRequestsRowHasNone')

  it('testASuccessfulReadCoversOmittedDaysWithoutInventingFigures', async () => {
    const sparse = '{"granularity":"day","buckets":[{"from":"2026-10-29T00:00:00Z","until":"2026-10-30T00:00:00Z","request_count":3}]}'
    const answer = new TestSwitch(jsonResponse(sparse))
    const http = new RoutingHTTPClient(() => answer.value)
    const source = new OllamaHistorySource(new OllamaUsageClient(http), 'key', 'ollama')
    const dates = UsageHistory.dayStartsBack(2, now, source.calendar)
    const read = await source.read(dates, now, source.calendar)
    expect(read.days.get(dates[0])).toEqual({ totals: UsageTotals.empty() })
    expect(read.days.get(dates[1])?.totals.values).toEqual({ requests: 3 })

    answer.value = new HTTPResponse(500, {}, new Uint8Array())
    const failed = await source.read(dates, now, source.calendar)
    expect(failed.days.size).toBe(0)
  })

  it('testDaysParseOllamasBucketsAndAnyMalformedBucketRejectsTheRead', () => {
    const utc = new Calendar('utc')
    const days = (buckets: string, granularity = 'day'): Map<Instant, UsageDay> | undefined =>
      OllamaHistorySource.days(`{"granularity":"${granularity}","buckets":[${buckets}]}`, utc)
    const september30 = OpenUsageISO8601.date('2026-09-30T00:00:00Z')
    if (september30 === undefined) throw new Error('bad fixture date')
    const day = '"from":"2026-09-30T00:00:00Z","until":"2026-10-01T00:00:00Z"'
    const documented =
      `{${day},"request_count":8,"usage_usd":0.0166,"input_tokens":52000,"cached_input_tokens":30000,` +
      '"output_tokens":7000,"groups":[{"model":"glm-5.3-flash","request_count":6,"usage_usd":0.0066,' +
      '"input_tokens":48000,"cached_input_tokens":30000,"output_tokens":6000},{"model":"glm-5.3",' +
      '"request_count":2,"usage_usd":0.01,"input_tokens":4000,"cached_input_tokens":0,"output_tokens":1000}]}'

    const parsed = days(documented)?.get(september30)
    expect(parsed).toBeDefined()
    expect(parsed?.totals.values).toEqual({
      requests: 8,
      usageValue: 0.0166,
      tokens: 59_000,
      inputTokens: 52_000,
      cacheReadTokens: 30_000,
      outputTokens: 7_000
    })
    expect(parsed?.byModel?.['glm-5.3']?.values.tokens).toBe(5_000)
    // a legacy day has requests only
    expect(days(`{${day},"request_count":3}`)?.get(september30)?.totals.values).toEqual({ requests: 3 })
    // usage beyond the named models leaves the day unsplit
    const unsplit = days(`{${day},"request_count":9,"groups":[{"model":"a","request_count":1}],"remainder":{"request_count":8}}`)?.get(september30)
    expect(unsplit).toBeDefined()
    expect(unsplit?.byModel).toBeUndefined()
    expect(days(`{${day},"request_count":0,"groups":[]}`)?.get(september30)?.byModel).toEqual({})

    for (const bucket of [
      `{${day}}`,
      `{${day},"request_count":-1}`,
      `{${day},"request_count":1,"usage_usd":"lots"}`,
      `{${day},"request_count":1,"groups":[{"request_count":1}]}`,
      `{${day},"request_count":2,"groups":[{"model":"a","request_count":1},{"model":"a","request_count":1}]}`,
      '{"from":"2026-09-30T02:00:00Z","until":"2026-09-30T03:00:00Z","request_count":1}',
      '{"from":"2026-09-30T00:00:00Z","until":"2026-10-02T00:00:00Z","request_count":1}',
      `{${day},"request_count":1},{${day},"request_count":1}`
    ]) {
      expect(days(bucket), bucket).toBeUndefined()
    }
    expect(days(`{${day},"request_count":1}`, 'hour')).toBeUndefined()
  })
})
