import type { MetricLine } from '../../models/MetricLine'
import { HTTPRequest, type HTTPClient, type HTTPResponse } from '../../services/HTTPClient'
import { LoginHTTP } from '../../services/OAuthLoginSupport'
import { AppInfo } from '../../support/AppInfo'
import { utf8 } from '../../support/ProviderParse'
import { ProviderError } from '../ProviderError'
import { CopilotOrgBillingMapper } from './CopilotOrgBillingMapper'
import { GitHubDomain } from './GitHubDomain'

const pathAllowed = /[A-Za-z0-9!$&'()*+,\-.:=@_~]/

/** `URL.appending(components:)`: each component percent-encoded as one path segment, slashes included. */
function appendingComponents(base: string, ...components: string[]): string {
  let url = base
  for (const component of components) {
    let encoded = ''
    for (const byte of utf8(component)) {
      const char = String.fromCharCode(byte)
      encoded += byte < 0x80 && pathAllowed.test(char) ? char : '%' + byte.toString(16).toUpperCase().padStart(2, '0')
    }
    url += `/${encoded}`
  }
  return url
}

/**
 * Calls GitHub's internal Copilot usage endpoint with a GitHub OAuth token. Mirrors the headers the
 * official Copilot client sends; `Authorization` uses the `token` scheme (not `Bearer`), which is what
 * `/copilot_internal/user` accepts.
 */
export class CopilotUsageClient {
  readonly http: HTTPClient

  constructor(http: HTTPClient) {
    this.http = http
  }

  async fetchUsage(token: string, domain: GitHubDomain): Promise<HTTPResponse> {
    return this.http.send(
      HTTPRequest.make(
        'GET',
        GitHubDomain.apiURL(domain, '/copilot_internal/user'),
        {
          Authorization: `token ${token}`,
          Accept: 'application/json',
          'Editor-Version': 'vscode/1.96.2',
          'Editor-Plugin-Version': 'copilot-chat/0.26.7',
          'User-Agent': 'GitHubCopilotChat/0.26.7',
          'X-Github-Api-Version': '2025-04-01'
        },
        undefined,
        15
      )
    )
  }

  static organizationUsageURL(organization: string): string {
    return appendingComponents('https://api.github.com/organizations', organization, 'settings', 'billing', 'ai_credit', 'usage')
  }

  /**
   * One organization's Copilot credits and spend this month, read with a token from an owner or
   * billing manager of the organization: the Copilot sign-in itself cannot read organization billing.
   */
  async organizationUsage(organization: string, token: string): Promise<MetricLine[]> {
    const response = await LoginHTTP.get(CopilotUsageClient.organizationUsageURL(organization), token, this.http, {
      Accept: 'application/vnd.github+json',
      'User-Agent': AppInfo.name,
      'X-GitHub-Api-Version': '2022-11-28'
    })
    if (ProviderError.isAuthFailure(response)) throw ProviderError.keyRejected('GitHub rejected the token.')
    if (response.statusCode === 404) {
      throw ProviderError.unavailable(`GitHub has no organization “${organization}” this token can read.`)
    }
    if (!(response.statusCode >= 200 && response.statusCode < 300)) throw ProviderError.failed(response)
    const lines = CopilotOrgBillingMapper.usageLines(response)
    if (!lines) throw ProviderError.invalidResponse
    return lines
  }
}
