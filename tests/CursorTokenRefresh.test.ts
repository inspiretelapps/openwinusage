import { describe, expect, it } from 'vitest'
import { Account, AccountCredential, OAuthTokens } from '@core/models/Account'
import type { ProviderSnapshot, RefreshResult } from '@core/models/ProviderSnapshot'
import { AccountProviderRuntime } from '@core/providers/AccountProviderRuntime'
import { CursorUsageClient } from '@core/providers/cursor/CursorUsageClient'
import { CursorLogin } from '@core/services/DeviceProviderLogins'
import { type HTTPRequest, type HTTPResponse } from '@core/services/HTTPClient'
import { bodyText } from '@core/support/ProviderParse'
import { addSeconds, type Instant } from '@core/support/time'
import { InMemoryCredentialVault, jsonResponse, RoutingHTTPClient, unix } from './TestSupport'

/**
 * Cursor's access token is a 60-day JWT that is also its refresh token. The login poll returns the
 * same JWT for both. `/oauth/token` answers with a new `access_token` and no `refresh_token`.
 * These shapes come from the live API on 2026-10-23. The tokens here are fake.
 */
const expiry = unix(4_000_000_000)
const newExpiry = addSeconds(expiry, 60 * 86_400)

function fakeJWT(exp: Instant, user: string): string {
  const payload = `{"sub":"auth0|user_${user}","exp":${Math.trunc(exp / 1000)},"type":"session"}`
  const encoded = Buffer.from(payload, 'utf8').toString('base64').replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
  return `eyJhbGciOiJIUzI1NiJ9.${encoded}.fake-signature`
}

const oldToken = fakeJWT(expiry, 'old')
const newToken = fakeJWT(newExpiry, 'new')

const usageBody = `{"billingCycleEnd":"1764547200000","billingCycleStart":"1761955200000","enabled":true,
 "planUsage":{"limit":2000,"remaining":1500,"totalPercentUsed":25}}`

const json = (text: string, status = 200): HTTPResponse => jsonResponse(text, status)

const refreshed = (): HTTPResponse => json(`{"access_token":"${newToken}","id_token":"fake","shouldLogout":false}`)

class Harness {
  constructor(
    readonly runtime: AccountProviderRuntime,
    readonly vault: InMemoryCredentialVault,
    readonly http: RoutingHTTPClient,
    readonly account: Account
  ) {}

  get stored(): OAuthTokens | undefined {
    let credential: AccountCredential | undefined
    try {
      credential = this.vault.load(this.account.id)
    } catch {
      return undefined
    }
    return credential?.type === 'oauth' ? credential.tokens : undefined
  }

  get refreshRequests(): HTTPRequest[] {
    return this.http.requests.filter((request) => request.url === CursorUsageClient.refreshURL)
  }

  get usageTokens(): (string | undefined)[] {
    return this.http.requests
      .filter((request) => request.url === CursorUsageClient.usageURL)
      .map((request) => request.headers?.Authorization?.replaceAll('Bearer ', ''))
  }
}

function harness(stored: OAuthTokens, now: Instant, refresh: HTTPResponse, acceptedTokens: Set<string>): Harness {
  const account = Account.make({ kind: 'cursor', label: 'Cursor Account' })
  const vault = new InMemoryCredentialVault()
  vault.save(AccountCredential.oauth(stored), account.id)
  const http = new RoutingHTTPClient((request) => {
    switch (request.url) {
      case CursorUsageClient.refreshURL:
        return refresh
      case CursorUsageClient.usageURL: {
        const token = request.headers?.Authorization?.replaceAll('Bearer ', '') ?? ''
        return acceptedTokens.has(token) ? json(usageBody) : json('{}', 401)
      }
      case CursorUsageClient.planURL:
        return json('{"planInfo":{"planName":"Pro"}}')
      default:
        return json('{}', 404)
    }
  })
  const runtime = new AccountProviderRuntime(account, vault, http, () => now)
  return new Harness(runtime, vault, http, account)
}

function assertRefreshedAndSaved(harness: Harness): void {
  const request = harness.refreshRequests[0]
  if (!request) throw new Error('no refresh request')
  if (!request.body) throw new Error('no refresh request body')
  const body = JSON.parse(bodyText(request.body)) as Record<string, string>
  expect(body.grant_type).toBe('refresh_token')
  expect(body.client_id).toBe(CursorUsageClient.clientID)
  expect(body.refresh_token).toBe(oldToken)
  expect(harness.stored).toEqual(OAuthTokens.make(newToken, newToken, newExpiry))
}

function snapshotOf(result: RefreshResult): ProviderSnapshot {
  if (!result.ok) throw new Error(`refresh failed: ${result.failure.message}`)
  return result.snapshot
}

describe('CursorTokenRefreshTests', () => {
  it('testLoginSavesTheAccessTokensExpiry', async () => {
    const http = new RoutingHTTPClient(() => json(`{"accessToken":"${oldToken}","refreshToken":"${oldToken}"}`))

    const result = await new CursorLogin(http).login(
      () => {},
      (async function* (): AsyncGenerator<string> {})()
    )

    if (result.credential.type !== 'oauth') throw new Error('Expected OAuth tokens')
    expect(result.credential.tokens.expiresAt).toBe(expiry)
  })

  it('testCredentialWithoutExpiryGetsOneFromItsJWT', async () => {
    const h = harness(OAuthTokens.make(oldToken, oldToken), addSeconds(expiry, -30 * 86_400), refreshed(), new Set([oldToken]))

    snapshotOf(await h.runtime.refresh())

    expect(h.stored?.expiresAt).toBe(expiry)
    expect(h.stored?.accessToken).toBe(oldToken)
    expect(h.refreshRequests.length).toBe(0)
  })

  it('testTokenNearExpiryIsRefreshedFirstAndSaved', async () => {
    const h = harness(OAuthTokens.make(oldToken, oldToken, expiry), addSeconds(expiry, -86_400), refreshed(), new Set([newToken]))

    snapshotOf(await h.runtime.refresh())

    expect(h.usageTokens).toEqual([newToken])
    assertRefreshedAndSaved(h)
  })

  it('testRejectedTokenIsRefreshedOnceAndRetried', async () => {
    const h = harness(OAuthTokens.make(oldToken, oldToken, expiry), addSeconds(expiry, -30 * 86_400), refreshed(), new Set([newToken]))

    snapshotOf(await h.runtime.refresh())

    expect(h.usageTokens).toEqual([oldToken, newToken])
    assertRefreshedAndSaved(h)
  })

  it('testFailedRefreshOfExpiredTokenReadsAsExpiredSignIn', async () => {
    const h = harness(
      OAuthTokens.make(oldToken, oldToken),
      addSeconds(expiry, 3_600),
      json('{"access_token":"","id_token":"","shouldLogout":true}'),
      new Set()
    )

    const result = await h.runtime.refresh()

    expect(h.refreshRequests.length).toBe(1)
    if (result.ok) throw new Error('Expected an error snapshot')
    expect(result.failure.message).toBe('Cursor sign-in expired. Sign in again to keep reading usage.')
    expect(h.stored?.accessToken).toBe(oldToken)
  })

  it('testFailedEarlyRefreshKeepsTheStillValidToken', async () => {
    const h = harness(OAuthTokens.make(oldToken, oldToken, expiry), addSeconds(expiry, -86_400), json('{}', 503), new Set([oldToken]))

    snapshotOf(await h.runtime.refresh())

    expect(h.refreshRequests.length).toBe(1)
    expect(h.usageTokens).toEqual([oldToken])
    expect(h.stored?.accessToken).toBe(oldToken)
  })
})
