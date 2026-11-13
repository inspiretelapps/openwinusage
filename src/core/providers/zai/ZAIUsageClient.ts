import { HTTPRequest, type HTTPClient, type HTTPResponse } from '../../services/HTTPClient'
import type { ZAIReset } from './ZAIResets'

export class ZAIUsageClient {
  static readonly subscriptionURL = 'https://api.z.ai/api/biz/subscription/list'
  static readonly quotaURL = 'https://api.z.ai/api/monitor/usage/quota/limit'
  static readonly resetListURL = 'https://api.z.ai/api/biz/customer-package-reset/list?targetType=PERSONAL'
  static readonly useResetURL = 'https://api.z.ai/api/biz/customer-package-reset/use'

  readonly http: HTTPClient

  constructor(http: HTTPClient) {
    this.http = http
  }

  async fetchSubscription(apiKey: string): Promise<HTTPResponse> {
    return this.get(ZAIUsageClient.subscriptionURL, apiKey)
  }

  async fetchQuota(apiKey: string): Promise<HTTPResponse> {
    return this.get(ZAIUsageClient.quotaURL, apiKey)
  }

  async fetchResets(apiKey: string): Promise<HTTPResponse> {
    return this.get(ZAIUsageClient.resetListURL, apiKey)
  }

  async useReset(reset: ZAIReset, requestID: string, apiKey: string): Promise<HTTPResponse> {
    // Keys in sorted order, as upstream serializes them.
    const payload = {
      grantType: reset.grantType,
      recordId: reset.recordID,
      requestId: requestID,
      resetType: reset.window,
      targetType: 'PERSONAL'
    }
    return this.http.send(
      HTTPRequest.make(
        'POST',
        ZAIUsageClient.useResetURL,
        {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
          'Content-Type': 'application/json'
        },
        JSON.stringify(payload),
        15
      )
    )
  }

  private async get(url: string, apiKey: string): Promise<HTTPResponse> {
    return this.http.send(
      HTTPRequest.make(
        'GET',
        url,
        {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json'
        },
        undefined,
        15
      )
    )
  }
}
