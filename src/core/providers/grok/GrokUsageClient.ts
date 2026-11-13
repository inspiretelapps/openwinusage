import { HTTPRequest, type HTTPClient, type HTTPResponse } from '../../services/HTTPClient'
import { AppInfo } from '../../support/AppInfo'

// Upstream's `extension GrokLogin { static func refresh }` in this file is `GrokLogin.refresh`
// in `services/DeviceProviderLogins`, beside the sign-in it renews.

export class GrokUsageClient {
  static readonly settingsURL = 'https://cli-chat-proxy.grok.com/v1/settings'
  static readonly tokenAuthHeader = 'xai-grok-cli'

  static readonly creditsConfigURL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits'

  readonly httpClient: HTTPClient

  constructor(httpClient: HTTPClient) {
    this.httpClient = httpClient
  }

  async fetchCreditsConfig(accessToken: string): Promise<HTTPResponse> {
    return this.httpClient.send(HTTPRequest.make('GET', GrokUsageClient.creditsConfigURL, this.authHeaders(accessToken), undefined, 10))
  }

  async fetchSettings(accessToken: string): Promise<HTTPResponse> {
    return this.httpClient.send(HTTPRequest.make('GET', GrokUsageClient.settingsURL, this.authHeaders(accessToken), undefined, 10))
  }

  private authHeaders(accessToken: string): Record<string, string> {
    return {
      Authorization: `Bearer ${accessToken.trim()}`,
      'X-XAI-Token-Auth': GrokUsageClient.tokenAuthHeader,
      Accept: 'application/json',
      'User-Agent': AppInfo.name
    }
  }
}
