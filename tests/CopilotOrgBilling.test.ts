import { describe, it, expect } from 'vitest'
import { Account, AccountCredential } from '@core/models/Account'
import { MetricLine } from '@core/models/MetricLine'
import { metricValue } from '@core/models/MetricValue'
import type { ProviderSnapshot, RefreshResult } from '@core/models/ProviderSnapshot'
import { AccountProviderRuntime } from '@core/providers/AccountProviderRuntime'
import { CopilotOrgBillingMapper } from '@core/providers/copilot/CopilotOrgBillingMapper'
import { CopilotUsageClient } from '@core/providers/copilot/CopilotUsageClient'
import { ProviderError } from '@core/providers/ProviderError'
import { CopilotOrganizationLogin } from '@core/services/DeviceProviderLogins'
import { HTTPResponse } from '@core/services/HTTPClient'
import { describeError } from '@core/support/AppLog'
import { InMemoryCredentialVault, RoutingHTTPClient, jsonResponse } from './TestSupport'

const orgBody = `
    {"timePeriod":{"year":2025},"organization":"GitHub","usageItems":[{"product":"Copilot","sku":"Copilot AI Credits",
     "model":"GPT-5","unitType":"credits","pricePerUnit":0.01,"grossQuantity":100,"grossAmount":1.0,"discountQuantity":0,
     "discountAmount":0.0,"netQuantity":100,"netAmount":1.0}]}
    `
const noCopilotBody = '{"usageItems":[{"product":"Actions","grossQuantity":500,"netAmount":4.0}]}'
const orgLines: MetricLine[] = [
  MetricLine.values('Org Credits', [metricValue(100, 'count', 'credits')]),
  MetricLine.values('Org Spend', [metricValue(1, 'dollars')])
]

/** A paste stream that yields `token` and ends. */
async function* pasting(token: string): AsyncGenerator<string> {
  yield token
}

function login(token: string, http: RoutingHTTPClient): Promise<{ label: string; credential: AccountCredential }> {
  return new CopilotOrganizationLogin('acme', http).login(() => {}, pasting(token))
}

/** `Result.get()` */
function get(result: RefreshResult): ProviderSnapshot {
  if (!result.ok) throw new Error(result.failure.message)
  return result.snapshot
}

describe('CopilotOrgBillingTests', () => {
  it('testOrgUsageCountsCopilotCreditsAndSpendOnly', () => {
    expect(CopilotOrgBillingMapper.usageLines(jsonResponse(orgBody))).toEqual(orgLines)
    expect(CopilotOrgBillingMapper.usageLines(jsonResponse(noCopilotBody)), 'an org with no Copilot usage yet shows zero').toEqual([
      MetricLine.values('Org Credits', [metricValue(0, 'count', 'credits')]),
      MetricLine.values('Org Spend', [metricValue(0, 'dollars')])
    ])
  })

  it('testAnInvalidOrgReportMapsToNothing', () => {
    for (const body of [
      'not json',
      '{}',
      '{"usageItems":{"product":"Copilot"}}',
      '{"usageItems":[{"product":"Copilot","grossQuantity":100}]}'
    ]) {
      expect(CopilotOrgBillingMapper.usageLines(jsonResponse(body)), body).toBeUndefined()
    }
  })

  it('testAddingAnOrganizationChecksTheTokenWithOneRead', async () => {
    const http = new RoutingHTTPClient((request) => {
      switch (request.headers?.Authorization) {
        case 'Bearer good':
          return jsonResponse(orgBody)
        case 'Bearer garbage':
          return jsonResponse('<html>')
        case 'Bearer elsewhere':
          return jsonResponse('{}', 404)
        default:
          return jsonResponse('{}', 403)
      }
    })

    const added = await login('good', http)
    expect(added.label).toBe('acme')
    expect(added.credential).toEqual(AccountCredential.apiKey('good'))
    const request = http.requests[0]
    expect(http.requests.length).toBe(1)
    expect(request.url).toBe('https://api.github.com/organizations/acme/settings/billing/ai_credit/usage')
    expect(request.headers?.['X-GitHub-Api-Version']).toBe('2022-11-28')
    expect(request.headers?.Accept).toBe('application/vnd.github+json')

    const refusals: [string, string][] = [
      ['refused', 'GitHub rejected the token.'],
      ['elsewhere', 'GitHub has no organization “acme” this token can read.'],
      ['garbage', ProviderError.invalidResponse.message]
    ]
    for (const [token, message] of refusals) {
      let accepted = false
      try {
        await login(token, http)
        accepted = true
      } catch (error) {
        expect(describeError(error), token).toBe(message)
      }
      expect(accepted, `${token} was accepted`).toBe(false)
    }
  })

  it('testGitHubsRateLimitOnAnOrganizationReadIsARateLimit', async () => {
    const http = new RoutingHTTPClient(() => new HTTPResponse(403, { 'retry-after': '60' }, '{}'))

    let accepted = false
    try {
      await new CopilotUsageClient(http).organizationUsage('acme', 'good')
      accepted = true
    } catch (error) {
      expect(ProviderError.rateLimited(60).equals(error)).toBe(true)
    }
    expect(accepted, 'a rate-limited read was accepted').toBe(false)
  })

  it('testAnOrganizationAccountShowsItsCreditsAndSpend', async () => {
    const account = Account.make({ kind: 'copilot', label: 'acme', organization: 'acme' })
    const vault = new InMemoryCredentialVault()
    vault.save(AccountCredential.apiKey('good'), account.id)
    const http = new RoutingHTTPClient(() => jsonResponse(orgBody))
    const snapshot = get(await new AccountProviderRuntime(account, vault, http).refresh())

    expect(snapshot.plan).toBeUndefined()
    expect(snapshot.lines).toEqual(orgLines)
    expect(http.requests.map((request) => request.url)).toEqual([CopilotUsageClient.organizationUsageURL('acme')])
  })

  // Drives `AccountStore` and `AppContainer`, which are not ported yet.
  it.todo('testReplacingTheTokenKeepsTheOrganizationAndAcceptsATokenAnotherOrganizationUses')
})
