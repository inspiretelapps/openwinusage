import { describe, it, expect } from 'vitest'
import { Account, AccountCredential, OAuthTokens } from '@core/models/Account'
import { MetricLine } from '@core/models/MetricLine'
import type { ProviderSnapshot, RefreshResult } from '@core/models/ProviderSnapshot'
import { AccountProviderRuntime } from '@core/providers/AccountProviderRuntime'
import { DevinLogin } from '@core/providers/devin/DevinLogin'
import { DevinUsageClient } from '@core/providers/devin/DevinUsageClient'
import type { HTTPRequest } from '@core/services/HTTPClient'
import { LoginError } from '@core/services/OAuthLoginSupport'
import type { LoginPrompt } from '@core/services/ProviderLogin'
import { describeError } from '@core/support/AppLog'
import { MetricPeriod } from '@core/support/MetricPeriod'
import { asObject, bodyText, type JSONObject } from '@core/support/ProviderParse'
import { InMemoryCredentialVault, RoutingHTTPClient, TestSwitch, jsonResponse } from './TestSupport'

const userStatus = `
{"userStatus":{"email":"rob@example.com","teamId":"devin-team$account-1",
 "planStatus":{"planInfo":{"planName":"Max"},"dailyQuotaRemainingPercent":80,"weeklyQuotaRemainingPercent":25}}}
`
const refused = '{"code":"unauthenticated","message":"invalid token"}'
const selfServeStatusURL = 'https://server.self-serve.windsurf.com/exa.seat_management_pb.SeatManagementService/GetUserStatus'

function jsonBody(request: HTTPRequest | undefined): JSONObject | undefined {
  if (request?.body === undefined) return undefined
  try {
    return asObject(JSON.parse(bodyText(request.body)))
  } catch {
    return undefined
  }
}

/** A paste stream that yields `values` and ends. */
async function* pasting(...values: string[]): AsyncGenerator<string> {
  for (const value of values) yield value
}

function signIn(value: string, http: RoutingHTTPClient): Promise<{ label: string; credential: AccountCredential }> {
  return new DevinLogin(http).login(() => {}, pasting(value))
}

/** `Result.get()` */
function get(result: RefreshResult): ProviderSnapshot {
  if (!result.ok) throw new Error(result.failure.message)
  return result.snapshot
}

describe('DevinLoginTests', () => {
  it('testTheBrowserOpensWindsurfsTokenPageWithAFreshState', async () => {
    const states: string[] = []
    for (let pass = 0; pass < 2; pass += 1) {
      const prompt = new TestSwitch<LoginPrompt | undefined>(undefined)
      const closedInput = pasting()
      const http = new RoutingHTTPClient(() => jsonResponse('{}', 500))
      try {
        await new DevinLogin(http).login((shown) => {
          prompt.value = shown
        }, closedInput)
      } catch {
        // `try?`: a closed paste stream cancels the sign-in.
      }

      const shown = prompt.value
      if (shown?.type !== 'browserToken') throw new Error(`expected the token page, got ${JSON.stringify(shown)}`)
      const page = new URL(shown.url)
      const query = Object.fromEntries(page.searchParams.entries())
      expect(`${page.protocol}//${page.host}${page.pathname}`).toBe('https://windsurf.com/profile')
      expect(query.response_type).toBe('token')
      expect(query.redirect_uri).toBe('show-auth-token')
      expect(query.scope).toBe('openid profile email')
      expect(query.redirect_parameters_type).toBe('query')
      expect(query.state).toBeDefined()
      states.push(query.state)
      expect(http.requests.length, 'nothing is sent before a token is pasted').toBe(0)
    }
    expect(states[0], 'every sign-in sends its own state').not.toBe(states[1])
  })

  it('testAPastedTokenIsTradedForTheAPIKeyOnTheServerWindsurfNames', async () => {
    const http = new RoutingHTTPClient((request) => {
      switch (request.url) {
        case 'https://api.codeium.com/register_user/':
          return jsonResponse('{"api_key":"devin-session-token$abc","name":"Rob","api_server_url":"https://server.self-serve.windsurf.com"}')
        case selfServeStatusURL:
          return jsonResponse(userStatus)
        default:
          return jsonResponse('{}', 404)
      }
    })

    const result = await signIn(' one-time-token\n', http)

    expect(result.label).toBe('rob@example.com')
    expect(result.credential).toEqual(
      AccountCredential.oauth(
        OAuthTokens.make('devin-session-token$abc', undefined, undefined, {
          [OAuthTokens.identityKey]: 'devin:rob@example.com/devin-team$account-1',
          [DevinUsageClient.apiServerURLKey]: 'https://server.self-serve.windsurf.com'
        })
      )
    )
    expect(http.requests.map((request) => request.url)).toEqual(['https://api.codeium.com/register_user/', selfServeStatusURL])
    expect(jsonBody(http.requests[0])).toEqual({ firebase_id_token: 'one-time-token' })
    expect(asObject(jsonBody(http.requests.at(-1))?.metadata)?.apiKey).toBe('devin-session-token$abc')
  })

  it('testAnAPIKeyPastedInsteadOfATokenSignsInOnTheDefaultServer', async () => {
    const http = new RoutingHTTPClient((request) =>
      new URL(request.url).host === 'api.codeium.com' ? jsonResponse(refused, 401) : jsonResponse('{"userStatus":{"email":"rob@example.com"}}')
    )

    const result = await signIn('devin-session-token$pasted', http)

    expect(result.credential).toEqual(
      AccountCredential.oauth(
        OAuthTokens.make('devin-session-token$pasted', undefined, undefined, { [OAuthTokens.identityKey]: 'devin:rob@example.com' })
      )
    )
    expect(http.requests.at(-1)?.url).toBe('https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus')
  })

  it('testATokenWindsurfRefusesAsksForANewOne', async () => {
    const http = new RoutingHTTPClient(() => jsonResponse(refused, 401))

    let signedIn = false
    try {
      await signIn('expired-token', http)
      signedIn = true
    } catch (error) {
      expect(describeError(error)).toBe(
        'Windsurf rejected that token. A token works for 5 minutes, so click Try Again to get a new one.'
      )
    }
    expect(signedIn, 'an expired token signed in').toBe(false)
  })

  it('testAnAPIServerOutsideHTTPSNeverReceivesTheKey', async () => {
    const http = new RoutingHTTPClient(() => jsonResponse('{"api_key":"devin-session-token$abc","api_server_url":"http://server.example"}'))

    let signedIn = false
    try {
      await signIn('one-time-token', http)
      signedIn = true
    } catch (error) {
      expect(describeError(error)).toBe(LoginError.invalidResponse.message)
    }
    expect(signedIn, 'signed in against a plain-HTTP server').toBe(false)
    expect(http.requests.length).toBe(1)
  })

  it('testARefreshReadsUsageFromTheAccountsOwnServer', async () => {
    const account = Account.make({ kind: 'devin', label: 'rob@example.com' })
    const vault = new InMemoryCredentialVault()
    vault.save(
      AccountCredential.oauth(
        OAuthTokens.make('devin-session-token$abc', undefined, undefined, {
          [DevinUsageClient.apiServerURLKey]: 'https://server.self-serve.windsurf.com'
        })
      ),
      account.id
    )
    const http = new RoutingHTTPClient(() => jsonResponse(userStatus))

    const snapshot = get(await new AccountProviderRuntime(account, vault, http).refresh())

    expect(snapshot.plan).toBe('Max')
    expect(snapshot.lines).toEqual([
      MetricLine.percent('Daily quota', 20, undefined, MetricPeriod.dayMs),
      MetricLine.percent('Weekly quota', 75, undefined, MetricPeriod.weekMs)
    ])
    expect(http.requests.map((request) => request.url)).toEqual([selfServeStatusURL])
  })
})
