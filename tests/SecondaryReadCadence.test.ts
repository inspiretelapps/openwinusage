import { describe, expect, it } from 'vitest'
import { Account, AccountCredential, OAuthTokens, ProviderKind } from '@core/models/Account'
import { metricValue } from '@core/models/MetricValue'
import { AccountProviderRuntime } from '@core/providers/AccountProviderRuntime'
import { AntigravityUsageClient } from '@core/providers/antigravity/AntigravityUsageClient'
import { CodexUsageClient } from '@core/providers/codex/CodexUsageClient'
import { CursorUsageClient } from '@core/providers/cursor/CursorUsageClient'
import { GrokUsageClient } from '@core/providers/grok/GrokUsageClient'
import { OllamaUsageClient } from '@core/providers/ollama/OllamaUsageClient'
import { ZAIUsageClient } from '@core/providers/zai/ZAIUsageClient'
import type { HTTPRequest, HTTPResponse } from '@core/services/HTTPClient'
import { RefreshSetting } from '@core/stores/RefreshSetting'
import { OpenUsageISO8601 } from '@core/support/OpenUsageISO8601'
import { addSeconds, fromUnixSeconds } from '@core/support/time'
import { InMemoryCredentialVault, isolatedDefaults, jsonResponse, RoutingHTTPClient, TestClock, TestSwitch } from './TestSupport'
import { get, storeForTesting } from './support/dataStoreHelpers'

const start = fromUnixSeconds(1_800_000_000)

/** `url.path` */
const pathOf = (url: string): string => new URL(url).pathname

function byPath(requests: HTTPRequest[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const request of requests) counts[pathOf(request.url)] = (counts[pathOf(request.url)] ?? 0) + 1
  return counts
}

const cursorCredential: AccountCredential = (() => {
  const token = 'e30.' + Buffer.from('{"sub":"auth0|user_fake"}', 'utf8').toString('base64').replaceAll('=', '') + '.sig'
  return AccountCredential.oauth(OAuthTokens.make(token, 'refresh', addSeconds(start, 30 * 86_400)))
})()

const cursorPools = '"planUsage":{"autoPercentUsed":20,"apiPercentUsed":40,"totalPercentUsed":25},"enabled":true'

function cursor(request: HTTPRequest, membership: string, usage: string): HTTPResponse {
  switch (request.url) {
    case CursorUsageClient.planURL:
      return jsonResponse('{"planInfo":{"planName":"Pro"}}')
    case CursorUsageClient.usageSummaryURL:
      return jsonResponse(`
            {"billingCycleStart":"2026-10-01T00:00:00Z","billingCycleEnd":"2026-11-01T00:00:00Z",
             "membershipType":"${membership}","individualUsage":{"onDemand":{"enabled":true,"used":100,"limit":1000}}}`)
    default:
      return jsonResponse(usage)
  }
}

async function passThenForcedRefresh(
  kind: ProviderKind,
  handler: (request: HTTPRequest) => HTTPResponse,
  credential: AccountCredential = AccountCredential.oauth(OAuthTokens.make('token'))
): Promise<Record<string, number>[]> {
  const account = Account.make({ kind, label: ProviderKind.displayName(kind) })
  const vault = new InMemoryCredentialVault()
  vault.save(credential, account.id)
  const http = new RoutingHTTPClient(handler)
  const clock = new TestClock(start)
  const runtime = new AccountProviderRuntime(account, vault, http, clock.now)
  const store = storeForTesting([runtime], { defaults: isolatedDefaults(), now: clock.now })
  await store.refreshAll()
  clock.set(addSeconds(start, RefreshSetting.interval))
  await store.refreshAll()
  const scheduled = byPath(http.requests)
  clock.set(addSeconds(start, RefreshSetting.interval + 60))
  await store.refreshAll(true)
  return [scheduled, byPath(http.requests)]
}

interface Counts {
  perHour: Record<string, number>
  total: number
  nextHour: Record<string, number>
  lastPlan?: string
}

async function hourOfRefreshes(kind: ProviderKind, credential: AccountCredential, handler: (request: HTTPRequest) => HTTPResponse): Promise<Counts> {
  const account = Account.make({ kind, label: ProviderKind.displayName(kind) })
  const vault = new InMemoryCredentialVault()
  vault.save(credential, account.id)
  const http = new RoutingHTTPClient(handler)
  const clock = new TestClock(start)
  const runtime = new AccountProviderRuntime(account, vault, http, clock.now)
  let lastPlan: string | undefined
  for (let pass = 0; pass < 12; pass++) {
    clock.set(addSeconds(start, pass * RefreshSetting.interval))
    const result = await runtime.refresh()
    lastPlan = result.ok ? result.snapshot.plan : undefined
  }
  const hour = [...http.requests]
  clock.set(addSeconds(start, RefreshSetting.secondaryReadInterval))
  await runtime.refresh()
  const next = http.requests.slice(hour.length)
  return { perHour: byPath(hour), total: hour.length, nextHour: byPath(next), lastPlan }
}

describe('SecondaryReadCadenceTests', () => {
  it('testCodexReadsResetCreditsHourly', async () => {
    const counts = await hourOfRefreshes('codex', AccountCredential.oauth(OAuthTokens.make('token')), () => jsonResponse('{"rate_limit":{}}'))
    expect(counts.perHour[pathOf(CodexUsageClient.usageURL)]).toBe(12)
    expect(counts.perHour[pathOf(CodexUsageClient.resetCreditsURL)]).toBe(1)
    const history = '/backend-api/wham/analytics/daily-workspace-usage-counts'
    expect(counts.perHour[history], 'the usage history is read once an hour').toBe(1)
    expect(counts.total).toBe(14)
    expect(counts.nextHour[pathOf(CodexUsageClient.resetCreditsURL)], 'read again once the hour is up').toBe(1)
    expect(counts.nextHour[history]).toBe(1)
  })

  it('testTheLiveResetCountWinsOverTheHourlyListAndKeepsItsExpiriesOnlyWhileTheyAgree', async () => {
    const expiry = OpenUsageISO8601.string(addSeconds(start, 3 * 86_400))
    const cases: { name: string; dedicated: number; live: number; expiries: number }[] = [
      { name: 'spent outside OpenUsage', dedicated: 1, live: 0, expiries: 0 },
      { name: 'granted since the hourly read', dedicated: 0, live: 1, expiries: 0 },
      { name: 'unchanged', dedicated: 1, live: 1, expiries: 1 }
    ]
    for (const entry of cases) {
      const account = Account.make({ kind: 'codex', label: 'Work' })
      const vault = new InMemoryCredentialVault()
      vault.save(AccountCredential.oauth(OAuthTokens.make('token')), account.id)
      const live = new TestSwitch(entry.dedicated)
      const http = new RoutingHTTPClient((request) => {
        switch (request.url) {
          case CodexUsageClient.resetCreditsURL: {
            const credits = entry.dedicated > 0 ? `{"id":"RateLimitResetCredit_1","status":"available","expires_at":"${expiry}"}` : ''
            return jsonResponse(`{"available_count":${entry.dedicated},"credits":[${credits}]}`)
          }
          default:
            return jsonResponse(`{"rate_limit":{},"rate_limit_reset_credits":{"available_count":${live.value}}}`)
        }
      })
      const clock = new TestClock(start)
      const runtime = new AccountProviderRuntime(account, vault, http, clock.now)
      await runtime.refresh()
      live.value = entry.live
      clock.set(addSeconds(start, RefreshSetting.interval))
      const snapshot = get(await runtime.refresh())

      const line = snapshot.lines.find((candidate) => candidate.label === 'Rate Limit Resets')
      if (line?.type !== 'values') throw new Error(`${entry.name}: no resets row`)
      expect(line.values, entry.name).toEqual([metricValue(entry.live, 'count', 'available')])
      expect(line.expiriesAt.length, entry.name).toBe(entry.expiries)
      expect(
        http.requests.filter((request) => request.url === CodexUsageClient.resetCreditsURL).length,
        `${entry.name}: the list is read once an hour`
      ).toBe(1)
    }
  })

  it('testGrokReadsThePlanHourly', async () => {
    const credits =
      '{"config":{"currentPeriod":{"type":"USAGE_PERIOD_TYPE_WEEKLY","start":"2026-06-30T21:36:52+00:00","end":"2026-07-07T21:36:52+00:00"},"creditUsagePercent":40}}'
    const counts = await hourOfRefreshes('grok', AccountCredential.oauth(OAuthTokens.make('token')), (request) =>
      request.url === GrokUsageClient.settingsURL ? jsonResponse('{"subscription_tier_display":"SuperGrok"}') : jsonResponse(credits)
    )
    expect(counts.perHour[pathOf(GrokUsageClient.settingsURL)]).toBe(1)
    expect(counts.total).toBe(13)
    expect(counts.lastPlan, 'the hourly plan still shows on every pass').toBe('SuperGrok')
  })

  it('testOllamaReadsThePlanHourly', async () => {
    const counts = await hourOfRefreshes('ollama', AccountCredential.apiKey('key'), () => jsonResponse('{}'))
    expect(counts.perHour[OllamaUsageClient.balancePath]).toBe(12)
    expect(counts.perHour[OllamaUsageClient.accountPath]).toBe(1)
    expect(counts.total).toBe(13)
  })

  it('testZAIReadsTheSubscriptionHourly', async () => {
    const counts = await hourOfRefreshes('zai', AccountCredential.apiKey('key'), () => jsonResponse('{}'))
    expect(counts.perHour[pathOf(ZAIUsageClient.quotaURL)]).toBe(12)
    expect(counts.perHour[pathOf(ZAIUsageClient.subscriptionURL)]).toBe(1)
    expect(counts.total).toBe(13)
  })

  it('testZAIReadsTheResetListHourly', async () => {
    const quota = '{"data":{"limits":[{"type":"CREDIT_LIMIT","unit":3,"number":5,"percentage":10}]},"success":true}'
    const counts = await hourOfRefreshes('zai', AccountCredential.apiKey('key'), (request) =>
      jsonResponse(request.url === ZAIUsageClient.quotaURL ? quota : '{"success":true,"data":{}}')
    )
    expect(counts.perHour[pathOf(ZAIUsageClient.quotaURL)]).toBe(12)
    expect(counts.perHour[pathOf(ZAIUsageClient.resetListURL)]).toBe(1)
    expect(counts.nextHour[pathOf(ZAIUsageClient.resetListURL)]).toBe(1)
  })

  it('testCursorReadsThePlanAndTheMembershipHourly', async () => {
    const counts = await hourOfRefreshes('cursor', cursorCredential, (request) => cursor(request, 'pro', `{${cursorPools}}`))
    expect(counts.perHour[pathOf(CursorUsageClient.usageURL)]).toBe(12)
    expect(counts.perHour[pathOf(CursorUsageClient.planURL)]).toBe(1)
    expect(counts.perHour[pathOf(CursorUsageClient.usageSummaryURL)], 'a personal seat reads usage-summary for its membership only').toBe(1)
    expect(counts.nextHour[pathOf(CursorUsageClient.planURL)], 'read again once the hour is up').toBe(1)
    expect(counts.nextHour[pathOf(CursorUsageClient.usageSummaryURL)], 'read again once the hour is up').toBe(1)
    expect(counts.lastPlan).toBe('Pro')
  })

  it('testACursorOrgSeatReadsUsageSummaryEveryRefreshOnlyForExtraUsageItsMainReadLacks', async () => {
    const cases: [string, number][] = [
      [`{${cursorPools}}`, 12],
      [`{${cursorPools},"spendLimitUsage":{"individualLimit":5000,"individualRemaining":4000}}`, 1]
    ]
    for (const [usage, perHour] of cases) {
      const counts = await hourOfRefreshes('cursor', cursorCredential, (request) => cursor(request, 'enterprise', usage))
      expect(counts.perHour[pathOf(CursorUsageClient.usageSummaryURL)], usage).toBe(perHour)
      expect(counts.lastPlan, usage).toBe('Enterprise')
    }
  })

  it('testAntigravityReadsCodeAssistHourly', async () => {
    const counts = await hourOfRefreshes('antigravity', AccountCredential.oauth(OAuthTokens.make('token')), (request) =>
      pathOf(request.url).endsWith(AntigravityUsageClient.loadCodeAssistPath)
        ? jsonResponse('{"cloudaicompanionProject":"p"}')
        : jsonResponse('{"groups":[{"displayName":"Gemini Models","buckets":[{"bucketId":"gemini-5h","remainingFraction":0.8}]}]}')
    )
    const loads = Object.entries(counts.perHour)
      .filter(([path]) => path.endsWith(AntigravityUsageClient.loadCodeAssistPath))
      .reduce((sum, [, count]) => sum + count, 0)
    expect(loads).toBe(1)
  })

  it('testAForcedRefreshAsksTheHourlyReadsAgain', async () => {
    const codex = await passThenForcedRefresh('codex', () => jsonResponse('{"rate_limit":{}}'))
    expect(codex.map((counts) => counts[pathOf(CodexUsageClient.resetCreditsURL)])).toEqual([1, 2])

    const ollama = await passThenForcedRefresh('ollama', () => jsonResponse('{}'), AccountCredential.apiKey('key'))
    expect(ollama.map((counts) => counts[OllamaUsageClient.accountPath])).toEqual([1, 2])

    const cursorCounts = await passThenForcedRefresh(
      'cursor',
      (request) => cursor(request, 'pro', '{"planUsage":{"totalPercentUsed":25},"enabled":true}'),
      cursorCredential
    )
    expect(cursorCounts.map((counts) => counts[pathOf(CursorUsageClient.usageSummaryURL)])).toEqual([1, 2])
  })
})
