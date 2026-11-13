import type { HTTPClient, HTTPResponse } from '../../services/HTTPClient'
import { LoginHTTP } from '../../services/OAuthLoginSupport'

export class OpenCodeUsageClient {
  static readonly usageURL = 'https://opencode.ai/zen/go/v1/usage'

  readonly http: HTTPClient

  constructor(http: HTTPClient) {
    this.http = http
  }

  async fetchUsage(apiKey: string): Promise<HTTPResponse> {
    return LoginHTTP.get(OpenCodeUsageClient.usageURL, apiKey, this.http, { Accept: 'application/json' })
  }
}
