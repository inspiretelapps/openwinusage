import { describe, expect, it } from 'vitest'
import { Account, AccountCredential, OAuthTokens } from '@core/models/Account'
import { NetworkError, type RefreshResult } from '@core/models/ProviderSnapshot'
import { AccountProviderRuntime } from '@core/providers/AccountProviderRuntime'
import { ProviderError } from '@core/providers/ProviderError'
import { AntigravityMetric } from '@core/providers/antigravity/AntigravityMetric'
import { AntigravityUsageClient } from '@core/providers/antigravity/AntigravityUsageClient'
import { AntigravityUsageMapper } from '@core/providers/antigravity/AntigravityUsageMapper'
import { AntigravityLogin } from '@core/services/BrowserProviderLogins'
import { HTTPResponse, type HTTPRequest } from '@core/services/HTTPClient'
import { asString, ProviderParse } from '@core/support/ProviderParse'
import { DISTANT_FUTURE } from '@core/support/time'
import { InMemoryCredentialVault, RoutingHTTPClient, TestSwitch } from './TestSupport'

/**
 * Free-tier Google accounts get 403 SUBSCRIPTION_REQUIRED from `retrieveUserQuotaSummary` unless the
 * request names the account's Cloud Code project from `loadCodeAssist`. Shapes taken from the live
 * API on 2026-10-23; values are fake.
 */
const loadCodeAssist = `{"allowedTiers":[{"id":"free-tier","isDefault":true,"name":"Antigravity Starter Quota"},{"id":"standard-tier","name":"Standard"}],
 "cloudaicompanionProject":"fake-project-123","currentTier":{"id":"free-tier","name":"Antigravity Starter Quota"},
 "gcpManaged":false,"paidTier":{"id":"free-tier","name":"Antigravity Starter Quota"}}`

const quotaSummary = `{"description":"fake","groups":[
  {"displayName":"Gemini","description":"fake","buckets":[{"bucketId":"gemini-weekly","displayName":"fake","remainingFraction":0.75,"resetTime":"2026-10-27T00:00:00Z","window":"weekly"}]},
  {"displayName":"Claude","description":"fake","buckets":[{"bucketId":"3p-weekly","displayName":"fake","remainingFraction":0.5,"resetTime":"2026-10-27T00:00:00Z","window":"weekly"}]}]}`

const subscriptionRequired =
  '{"error":{"code":403,"message":"fake","status":"PERMISSION_DENIED","details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":"SUBSCRIPTION_REQUIRED","domain":"cloudaicompanion.googleapis.com"}]}}'

const path = (request: HTTPRequest): string => new URL(request.url).pathname

function project(request: HTTPRequest): string | undefined {
  return request.body === undefined ? undefined : asString(ProviderParse.jsonObject(request.body)?.project)
}

function savedAccount(accessToken = 'access', refreshToken = 'refresh'): { account: Account; vault: InMemoryCredentialVault } {
  const account = Account.make({ kind: 'antigravity', label: 'Google Account' })
  const vault = new InMemoryCredentialVault()
  vault.save(AccountCredential.oauth(OAuthTokens.make(accessToken, refreshToken, DISTANT_FUTURE)), account.id)
  return { account, vault }
}

async function refresh(forbiddenBody?: string): Promise<RefreshResult> {
  const { account, vault } = savedAccount()
  const http = new RoutingHTTPClient((request) => {
    switch (path(request)) {
      case AntigravityUsageClient.loadCodeAssistPath:
        return new HTTPResponse(200, {}, loadCodeAssist)
      case AntigravityUsageClient.quotaSummaryPath:
        if (forbiddenBody !== undefined) {
          return new HTTPResponse(403, {}, forbiddenBody)
        }
        if (project(request) !== 'fake-project-123') {
          return new HTTPResponse(403, {}, subscriptionRequired)
        }
        return new HTTPResponse(200, {}, quotaSummary)
      default:
        return new HTTPResponse(404, {}, new Uint8Array())
    }
  })
  return new AccountProviderRuntime(account, vault, http).refresh()
}

function snapshotOf(result: RefreshResult) {
  if (!result.ok) throw new Error(`refresh failed: ${result.failure.message}`)
  return result.snapshot
}

function failureOf(result: RefreshResult) {
  return result.ok ? undefined : result.failure
}

describe('AntigravityProjectQuotaTests', () => {
  it('testQuotaSummaryNamesTheAccountsProject', async () => {
    const snapshot = snapshotOf(await refresh())

    expect(snapshot.lines.map((line) => line.label)).toEqual([AntigravityMetric.weeklyLabel, AntigravityMetric.claudeWeeklyLabel])
    expect(snapshot.plan).toBe('Antigravity Starter Quota')
  })

  it('testQuotaAccessDenialReportsTheReasonGoogleSupplied', async () => {
    const noSubscription = await refresh(subscriptionRequired)
    expect(failureOf(noSubscription)?.message).toBe('Google reports no Antigravity quota subscription for this project.')

    const refused = await refresh('{"error":{"status":"PERMISSION_DENIED"}}')
    expect(failureOf(refused)?.message).toBe(ProviderError.signInExpired('antigravity').message)
  })

  it('testEveryBaseOfflineIsUnreachable', async () => {
    const { account, vault } = savedAccount()
    const http = new RoutingHTTPClient(() => {
      throw new NetworkError()
    })

    const failure = failureOf(await new AccountProviderRuntime(account, vault, http).refresh())

    expect(http.requests.filter((request) => path(request) === AntigravityUsageClient.quotaSummaryPath).length).toBe(2)
    expect(failure?.kind).toEqual({ type: 'unreachable' })
  })

  it('testBothBasesRateLimitedKeepTheirRetryAfter', async () => {
    const { account, vault } = savedAccount()
    const http = new RoutingHTTPClient((request) => {
      if (path(request) !== AntigravityUsageClient.quotaSummaryPath) {
        return new HTTPResponse(200, {}, loadCodeAssist)
      }
      return new HTTPResponse(429, { 'retry-after': '120' }, new Uint8Array())
    })

    const failure = failureOf(await new AccountProviderRuntime(account, vault, http).refresh())

    expect(failure?.kind).toEqual({ type: 'rateLimited', retryAfter: 120 })
  })

  it('testAnUnauthorizedQuotaReadRenewsTheSignInOnceAndRetries', async () => {
    const { account, vault } = savedAccount('old-access', 'old-refresh')
    const http = new RoutingHTTPClient((request) => {
      if (request.url === AntigravityLogin.tokenURL) {
        return new HTTPResponse(200, {}, '{"access_token":"new-access","expires_in":3600}')
      }
      switch (path(request)) {
        case AntigravityUsageClient.loadCodeAssistPath:
          return new HTTPResponse(200, {}, loadCodeAssist)
        case AntigravityUsageClient.quotaSummaryPath:
          if (request.headers?.Authorization === 'Bearer new-access') return new HTTPResponse(200, {}, quotaSummary)
          return new HTTPResponse(401, {}, new Uint8Array())
        default:
          return new HTTPResponse(401, {}, new Uint8Array())
      }
    })

    const snapshot = snapshotOf(await new AccountProviderRuntime(account, vault, http).refresh())

    expect(snapshot.lines.map((line) => line.label)).toEqual([AntigravityMetric.weeklyLabel, AntigravityMetric.claudeWeeklyLabel])
    expect(http.requests.filter((request) => request.url === AntigravityLogin.tokenURL).length).toBe(1)
    const saved = vault.load(account.id)
    if (saved?.type !== 'oauth') throw new Error('Expected saved tokens')
    expect(saved.tokens.accessToken).toBe('new-access')
  })

  it('testAFailedProjectLookupIsReadAgainOnTheNextRefresh', async () => {
    const { account, vault } = savedAccount()
    const lookupWorks = new TestSwitch(false)
    const http = new RoutingHTTPClient((request) => {
      switch (path(request)) {
        case AntigravityUsageClient.loadCodeAssistPath:
          if (!lookupWorks.value) return new HTTPResponse(503, {}, new Uint8Array())
          return new HTTPResponse(200, {}, loadCodeAssist)
        case AntigravityUsageClient.quotaSummaryPath:
          if (project(request) !== 'fake-project-123') {
            return new HTTPResponse(403, {}, subscriptionRequired)
          }
          return new HTTPResponse(200, {}, quotaSummary)
        default:
          return new HTTPResponse(404, {}, new Uint8Array())
      }
    })
    const runtime = new AccountProviderRuntime(account, vault, http)
    const first = await runtime.refresh()
    expect(failureOf(first)?.message).toBe("Antigravity couldn't find a project with quota access for this account. Try again shortly.")

    lookupWorks.value = true
    const snapshot = snapshotOf(await runtime.refresh())

    expect(snapshot.lines.map((line) => line.label)).toEqual([AntigravityMetric.weeklyLabel, AntigravityMetric.claudeWeeklyLabel])
    expect(snapshot.plan).toBe('Antigravity Starter Quota')
  })

  it('testPaidTiersReadAsGoogleSellsThem', () => {
    const plan = (id: string, name: string): string | undefined =>
      AntigravityUsageMapper.parseLoadCodeAssistPlan(`{"paidTier":{"id":"${id}","name":"${name}"}}`)
    expect(plan('g1-pro-tier', 'fake')).toBe('Google AI Pro')
    expect(plan('g1-ultra-tier', 'fake')).toBe('Google AI Ultra')
    expect(plan('g1-ultra-lite-tier', 'fake')).toBe('Google AI Ultra Lite')
    expect(plan('unknown-tier', 'Google AI Pro')).toBe('Google AI Pro')
    expect(plan('unknown-tier', 'Gemini Code Assist in Google One AI Pro')).toBe('Google AI Pro')
    expect(plan('unknown-tier', 'Google AI Ultra Lite')).toBe('Google AI Ultra Lite')
    expect(plan('free-tier', 'Antigravity Starter Quota')).toBe('Antigravity Starter Quota')
    expect(plan('unknown-tier', '')).toBeUndefined()
  })
})
