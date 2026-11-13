import { describe, it, expect } from 'vitest'
import { Account, AccountCredential, OAuthTokens } from '@core/models/Account'
import type { RefreshResult } from '@core/models/ProviderSnapshot'
import { AccountProviderRuntime } from '@core/providers/AccountProviderRuntime'
import { GitHubDomain } from '@core/providers/copilot/GitHubDomain'
import { CopilotLogin } from '@core/services/DeviceProviderLogins'
import type { HTTPRequest, HTTPResponse } from '@core/services/HTTPClient'
import type { LoginPrompt } from '@core/services/ProviderLogin'
import { bodyText } from '@core/support/ProviderParse'
import { InMemoryCredentialVault, RoutingHTTPClient, jsonResponse } from './TestSupport'

const enterprise = GitHubDomain.enterprise('octocorp.ghe.com')
const usage =
  '{"copilot_plan":"enterprise","quota_reset_date":"2026-12-01","quota_snapshots":{"premium_interactions":{"entitlement":300,"remaining":240,"percent_remaining":80}}}'

/** A GitHub that signs in user 42, `robin`, on whatever host is asked. */
function gitHub(usageResponse: HTTPResponse): RoutingHTTPClient {
  return new RoutingHTTPClient((request) => {
    const url = new URL(request.url)
    const host = url.host
    switch (url.pathname) {
      case '/login/device/code':
        return jsonResponse(
          `{"device_code":"device","user_code":"ABCD-EFGH","verification_uri":"https://${host}/login/device","expires_in":600,"interval":1}`
        )
      case '/login/oauth/access_token':
        return jsonResponse('{"access_token":"copilot-access"}')
      case '/user':
        return jsonResponse('{"id":42,"login":"robin"}')
      case '/copilot_internal/user':
        return usageResponse
      default:
        return jsonResponse('{}', 404)
    }
  })
}

function clientID(request: HTTPRequest): string | undefined {
  const body = request.body === undefined ? '' : bodyText(request.body)
  return new URL(`https://example.invalid/?${body}`).searchParams.get('client_id') ?? undefined
}

/** `AsyncStream { $0.finish() }`: a paste stream that ends without a value. */
async function* finished(): AsyncGenerator<string> {}

/** `credential.identity` */
function identity(credential: AccountCredential): string | undefined {
  return credential.type === 'oauth' ? credential.tokens.extras[OAuthTokens.identityKey] : undefined
}

class DeviceCodeCapture {
  verificationURL: string | undefined

  store(prompt: LoginPrompt): void {
    if (prompt.type !== 'deviceCode') return
    this.verificationURL = prompt.verificationURL
  }
}

function failureMessage(result: RefreshResult): string | undefined {
  return result.ok ? undefined : result.failure.message
}

/**
 * Copilot on a company's GHE.com domain (#1602): the Domain step, the hosts each sign-in uses, and how
 * enterprise accounts are told apart from github.com ones.
 */
describe('CopilotEnterpriseTests', () => {
  it('testTheDomainIsNormalizedAndOnlyGHEComIsAccepted', () => {
    for (const blank of ['', '   ', 'github.com', ' GitHub.com ', 'https://github.com/settings/copilot', 'www.github.com']) {
      expect(GitHubDomain.parsing(blank), blank).toEqual(GitHubDomain.github)
    }
    for (const typed of [
      'octocorp',
      'OctoCorp',
      ' octocorp.ghe.com ',
      'https://octocorp.ghe.com/login/device',
      'octocorp.ghe.com/?x=1',
      'octocorp.GHE.com#a'
    ]) {
      expect(GitHubDomain.parsing(typed), typed).toEqual(enterprise)
    }
    expect(GitHubDomain.parsing('octo-corp-2')).toEqual(GitHubDomain.enterprise('octo-corp-2.ghe.com'))
    for (const invalid of [
      'github.acme.com',
      'ghe.com',
      '.ghe.com',
      'a.b.ghe.com',
      '-octo.ghe.com',
      'octo-.ghe.com',
      'octo corp',
      'octo_corp.ghe.com',
      'octocorp.ghe.com:8443'
    ]) {
      expect(GitHubDomain.parsing(invalid), invalid).toBeUndefined()
    }
  })

  it('testGitHubComSignInKeepsTodaysHostsAndReadsNoUsage', async () => {
    const http = gitHub(jsonResponse('{}', 404))

    const result = await new CopilotLogin(http, GitHubDomain.github).login(() => {}, finished())

    expect(result.label).toBe('robin')
    expect(identity(result.credential)).toBe('github:42')
    expect(http.requests.map((request) => request.url)).toEqual([
      'https://github.com/login/device/code',
      'https://github.com/login/oauth/access_token',
      'https://api.github.com/user'
    ])
    expect(clientID(http.requests[0])).toBe(CopilotLogin.clientID)
  })

  it('testEnterpriseSignInUsesTheDomainsHostsAndChecksTheSeatOnce', async () => {
    const http = gitHub(jsonResponse(usage))
    const prompt = new DeviceCodeCapture()

    const result = await new CopilotLogin(http, enterprise).login((shown: LoginPrompt) => prompt.store(shown), finished())

    expect(result.label).toBe('robin')
    expect(identity(result.credential)).toBe('github:octocorp.ghe.com:42')
    expect(http.requests.map((request) => request.url)).toEqual([
      'https://octocorp.ghe.com/login/device/code',
      'https://octocorp.ghe.com/login/oauth/access_token',
      'https://api.octocorp.ghe.com/user',
      'https://api.octocorp.ghe.com/copilot_internal/user'
    ])
    expect(clientID(http.requests[0]), 'the same client id as github.com').toBe(CopilotLogin.clientID)
    expect(prompt.verificationURL === undefined ? undefined : new URL(prompt.verificationURL).host).toBe('octocorp.ghe.com')
  })

  it('testRefreshReadsUsageFromTheAccountsDomain', async () => {
    const cases: [string | undefined, string][] = [
      [undefined, 'api.github.com'],
      ['octocorp.ghe.com', 'api.octocorp.ghe.com']
    ]
    for (const [domain, host] of cases) {
      const account = Account.make({ kind: 'copilot', label: 'robin', domain })
      const vault = new InMemoryCredentialVault()
      vault.save(AccountCredential.oauth(OAuthTokens.make('token')), account.id)
      const http = new RoutingHTTPClient(() => jsonResponse(usage))

      const result = await new AccountProviderRuntime(account, vault, http).refresh()

      expect(failureMessage(result), host).toBeUndefined()
      expect(http.requests.map((request) => request.url)).toEqual([`https://${host}/copilot_internal/user`])
    }
  })

  // The cases below drive `AddAccountFlow` and `AccountStore`, which are not ported yet.
  it.todo('testAnEnterpriseAccountWithoutASeatIsNeverAdded')
  it.todo('testAnUnreachableDomainSaysSo')
  it.todo('testAnInvalidDomainStaysOnTheDomainStep')
  it.todo('testTheDomainIsSavedOnTheAccountAndGitHubComSavesNone')
  it.todo('testTheSameEnterpriseUserIsNotAddedTwice')
  it.todo('testSigningInAgainReusesTheSavedDomainAndSkipsTheDomainStep')
  it.todo('testAnAccountSavedBeforeDomainsSignsInAtGitHubCom')
})
