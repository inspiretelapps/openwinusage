import { HTTPRequest, type HTTPClient, type HTTPResponse } from '../../services/HTTPClient'
import { AppInfo } from '../../support/AppInfo'

// Upstream keeps `CodexLogin.refresh` in this file; here it lives with the sign-in, in
// `services/BrowserProviderLogins`.

/** One `name=value` of a report's query string: Swift's `URLQueryItem`. */
export interface CodexQueryItem {
  name: string
  value: string
}

export class CodexUsageClient {
  static readonly usageURL = 'https://chatgpt.com/backend-api/wham/usage'
  static readonly resetCreditsURL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits'
  static readonly consumeResetCreditURL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume'
  static readonly reportsURL = 'https://chatgpt.com/backend-api/wham/'

  constructor(readonly http: HTTPClient) {}

  fetchUsage(accessToken: string, accountID: string | undefined): Promise<HTTPResponse> {
    return this.http.send(HTTPRequest.make('GET', CodexUsageClient.usageURL, CodexUsageClient.usageHeaders(accessToken, accountID), undefined, 10))
  }

  /** One of the daily usage reports the Codex client's Analytics view reads, at `path` under `wham/`. */
  fetchReport(path: string, query: CodexQueryItem[], accessToken: string, accountID: string | undefined): Promise<HTTPResponse> {
    let url = CodexUsageClient.reportsURL + path
    if (query.length > 0) {
      url += '?' + query.map((item) => `${encodeURIComponent(item.name)}=${encodeURIComponent(item.value)}`).join('&')
    }
    return this.http.send(HTTPRequest.make('GET', url, CodexUsageClient.usageHeaders(accessToken, accountID), undefined, 15))
  }

  /**
   * On-demand rate-limit reset credits, including each credit's expiry. A separate endpoint from
   * `usage`, whose `rate_limit_reset_credits` carries only the count. The extra headers mirror the Codex
   * desktop client, which the endpoint expects.
   */
  fetchResetCredits(accessToken: string, accountID: string | undefined): Promise<HTTPResponse> {
    return this.http.send(
      HTTPRequest.make('GET', CodexUsageClient.resetCreditsURL, CodexUsageClient.resetCreditHeaders(accessToken, accountID), undefined, 10)
    )
  }

  consumeResetCredit(accessToken: string, accountID: string | undefined, creditID: string, redeemRequestID: string): Promise<HTTPResponse> {
    const headers = CodexUsageClient.resetCreditHeaders(accessToken, accountID)
    headers['Content-Type'] = 'application/json'
    // Keys in sorted order, as upstream serializes them.
    const payload = { credit_id: creditID, redeem_request_id: redeemRequestID }
    return this.http.send(HTTPRequest.make('POST', CodexUsageClient.consumeResetCreditURL, headers, JSON.stringify(payload), 15))
  }

  private static resetCreditHeaders(accessToken: string, accountID: string | undefined): Record<string, string> {
    return { ...CodexUsageClient.usageHeaders(accessToken, accountID), 'OpenAI-Beta': 'codex-1', originator: 'Codex Desktop' }
  }

  private static usageHeaders(accessToken: string, accountID: string | undefined): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'User-Agent': AppInfo.name
    }
    if (accountID !== undefined && accountID.length > 0) {
      headers['ChatGPT-Account-Id'] = accountID
    }
    return headers
  }
}
