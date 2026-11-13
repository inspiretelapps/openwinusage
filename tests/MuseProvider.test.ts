import { describe, it, expect } from 'vitest'
import { Account, AccountCredential, OAuthTokens } from '@core/models/Account'
import { MetricLine } from '@core/models/MetricLine'
import { ProviderSnapshot, type RefreshResult } from '@core/models/ProviderSnapshot'
import { AccountProviderRuntime } from '@core/providers/AccountProviderRuntime'
import { MuseUsageClient } from '@core/providers/muse/MuseUsageClient'
import { ProviderError } from '@core/providers/ProviderError'
import { HTTPResponse } from '@core/services/HTTPClient'
import { MetricPeriod } from '@core/support/MetricPeriod'
import { bodyText } from '@core/support/ProviderParse'
import { addSeconds, toUnixSeconds } from '@core/support/time'
import { InMemoryCredentialVault, RoutingHTTPClient, TestClock, TestSwitch, unix } from './TestSupport'

const inferenceKey = 'LLM|1234|SYNTHETIC-inference-key'
const start = unix(1_793_790_000)
const sessionReset = addSeconds(start, 3 * 3600)
const weeklyReset = addSeconds(start, 3 * 86400)
const active = body(
  true,
  `{"window":{"used_percent":42,"resets_at":${Math.trunc(toUnixSeconds(sessionReset))},"window_duration_mins":300},` +
    `"weekly":{"used_percent":18,"resets_at":${Math.trunc(toUnixSeconds(weeklyReset))}}}`
)

function body(subscribed = true, usage?: string): string {
  const usageField = usage === undefined ? '' : `,"subs_usage":${usage}`
  return `{"api_key":"${inferenceKey}","user_email":"muse@example.com","is_subs_active":${subscribed},"subs_tier_name":"Power Usage"${usageField}}`
}

function response(status: number, text: string, headers: Record<string, string> = {}): HTTPResponse {
  return new HTTPResponse(status, headers, text)
}

interface Harness {
  runtime: AccountProviderRuntime
  vault: InMemoryCredentialVault
  http: RoutingHTTPClient
  clock: TestClock
  answer: TestSwitch<HTTPResponse>
}

function harness(first: HTTPResponse): Harness {
  const account = Account.make({ kind: 'muse', label: 'muse@example.com' })
  const vault = new InMemoryCredentialVault()
  vault.save(AccountCredential.oauth(OAuthTokens.make('dca:token')), account.id)
  const answer = new TestSwitch(first)
  const http = new RoutingHTTPClient(() => answer.value)
  const clock = new TestClock(start)
  const runtime = new AccountProviderRuntime(account, vault, http, clock.now)
  return { runtime, vault, http, clock, answer }
}

/** `Result.get()` */
function get(result: RefreshResult): ProviderSnapshot {
  if (!result.ok) throw new Error(result.failure.message)
  return result.snapshot
}

function failureOf(result: RefreshResult) {
  return result.ok ? undefined : result.failure
}

describe('MuseProviderTests', () => {
  it('testReadsThePlanSessionAndWeeklyWithOneKeyRead', async () => {
    const h = harness(response(200, active))

    const snapshot = get(await h.runtime.refresh())

    expect(snapshot.plan).toBe('Power Usage')
    expect(snapshot.lines).toEqual([
      MetricLine.percent('Session', 42, sessionReset, MetricPeriod.sessionMs),
      MetricLine.percent('Weekly', 18, weeklyReset, MetricPeriod.weekMs)
    ])
    expect(h.http.requests.length).toBe(1)
    const request = h.http.requests[0]
    expect(request.method).toBe('POST')
    expect(request.url).toBe(MuseUsageClient.keyURL)
    expect(request.headers?.Authorization).toBe('Bearer dca:token')
    expect(request.headers?.['x-api-version']).toBe('1.0.0')
    expect(request.body === undefined ? undefined : bodyText(request.body)).toBe('{"onboard":false}')
    expect(h.runtime.widgetDescriptors.map((descriptor) => descriptor.key)).toEqual(['session', 'weekly'])
  })

  it('testAWindowMuseLeavesOutKeepsItsLastKnownValue', async () => {
    const h = harness(response(200, active))
    const reported = get(await h.runtime.refresh()).lines

    h.answer.value = response(200, body())
    const idle = get(await h.runtime.refresh()).lines
    expect(idle, 'an idle window is not 0%').toEqual(reported)

    const relaunched = harness(response(200, body()))
    relaunched.runtime.restore(ProviderSnapshot.forProvider(relaunched.runtime.provider, 'Power Usage', reported))
    const restored = get(await relaunched.runtime.refresh()).lines
    expect(restored, 'the saved values carry over a relaunch').toEqual(reported)

    h.clock.set(addSeconds(sessionReset, 60))
    const afterReset = get(await h.runtime.refresh()).lines
    expect(afterReset, 'a kept window past its reset has reset').toEqual([
      MetricLine.percent('Session', 0, undefined, MetricPeriod.sessionMs),
      MetricLine.percent('Weekly', 18, weeklyReset, MetricPeriod.weekMs)
    ])

    const partial = harness(response(200, active))
    get(await partial.runtime.refresh())
    partial.answer.value = response(200, body(true, '{"weekly":{"used_percent":20}}'))
    const weeklyOnly = get(await partial.runtime.refresh()).lines
    expect(weeklyOnly, 'a reported usage keeps nothing it left out').toEqual([
      MetricLine.percent('Session', 0, undefined, MetricPeriod.sessionMs),
      MetricLine.percent('Weekly', 20, undefined, MetricPeriod.weekMs)
    ])
  })

  it('testAPlanNotUsedYetShowsSessionAndWeeklyAtZero', async () => {
    const h = harness(response(200, body()))

    const snapshot = get(await h.runtime.refresh())

    expect(snapshot.plan).toBe('Power Usage')
    expect(snapshot.lines, 'Muse reports no usage before the first prompt').toEqual([
      MetricLine.percent('Session', 0, undefined, MetricPeriod.sessionMs),
      MetricLine.percent('Weekly', 0, undefined, MetricPeriod.weekMs)
    ])
  })

  it('testUsageOverTheLimitIsKept', async () => {
    const h = harness(response(200, body(true, '{"weekly":{"used_percent":130.5,"resets_at":1794000000}}')))

    const lines = get(await h.runtime.refresh()).lines

    expect(lines.at(-1)).toEqual(MetricLine.percent('Weekly', 130.5, unix(1_794_000_000), MetricPeriod.weekMs))
  })

  it('testAnAccountWithoutASubscriptionSaysSo', async () => {
    const h = harness(response(200, body(false)))

    const failure = await h.runtime.refresh()

    expect(failureOf(failure)?.message).toBe('No Muse Code subscription on this account.')
  })

  it('testARefusedSignInAsksToSignInAgain', async () => {
    const h = harness(response(401, '{"error":"unauthorized"}'))

    const failure = await h.runtime.refresh()

    expect(failureOf(failure)?.message).toBe(ProviderError.signInExpired('muse').message)
    expect(failureOf(failure)?.kind).toEqual({ type: 'refused' })
  })

  it('testARateLimitWaitsAsLongAsMuseAsks', async () => {
    const h = harness(response(429, '', { 'retry-after': '120' }))

    const failure = await h.runtime.refresh()

    expect(failureOf(failure)?.kind).toEqual({ type: 'rateLimited', retryAfter: 120 })
  })

  it('testTheInferenceKeyNeverReachesStorageOrLogs', async () => {
    const h = harness(response(200, active))
    const snapshot = get(await h.runtime.refresh())

    const saved = JSON.stringify(snapshot)
    expect(saved.includes('SYNTHETIC-inference-key'), 'the cached snapshot').toBe(false)
    expect(h.vault.load(h.runtime.account.id)).toEqual(AccountCredential.oauth(OAuthTokens.make('dca:token')))
    const decoded = await new MuseUsageClient(h.http).account('dca:token')
    expect(JSON.stringify(decoded).includes('SYNTHETIC-inference-key'), 'the decoded response').toBe(false)

    for (const unreadable of [
      response(200, `{"api_key":"${inferenceKey}","is_subs_active":"yes"}`),
      response(500, active),
      response(429, active)
    ]) {
      h.answer.value = unreadable
      const result = await h.runtime.refresh()
      const message = failureOf(result)?.message
      expect(message).toBeDefined()
      expect(message?.includes('SYNTHETIC-inference-key'), `the logged failure for HTTP ${unreadable.statusCode}`).toBe(false)
    }
  })
})
