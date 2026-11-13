import type { MetricLine } from '../../models/MetricLine'
import { UsageTotals } from '../../models/UsageHistory'
import type { HTTPClient, HTTPResponse } from '../../services/HTTPClient'
import { LoginHTTP } from '../../services/OAuthLoginSupport'
import type { Instant } from '../../support/time'
import { ProviderError } from '../ProviderError'
import { OpenRouterUsageMapper, type OpenRouterKey, type OpenRouterSpend } from './OpenRouterUsageMapper'

export class OpenRouterUsageClient {
  static readonly creditsURL = 'https://openrouter.ai/api/v1/credits'
  static readonly keyURL = 'https://openrouter.ai/api/v1/key'
  static readonly keysURL = 'https://openrouter.ai/api/v1/keys'
  static readonly activityURL = 'https://openrouter.ai/api/v1/activity'
  static readonly keysPageSize = 100
  /** Bounds the page loop should OpenRouter ever ignore `offset`. */
  static readonly maxKeysPages = 50

  readonly http: HTTPClient

  constructor(http: HTTPClient) {
    this.http = http
  }

  async key(apiKey: string, now: Instant): Promise<OpenRouterKey> {
    return OpenRouterUsageMapper.key(await this.get(OpenRouterUsageClient.keyURL, apiKey), now)
  }

  /**
   * Empty for a Management key scoped to one workspace: OpenRouter bills credits per account and
   * refuses such a key the account's credits with a 403.
   */
  async creditsLines(apiKey: string): Promise<MetricLine[]> {
    const response = await this.send(OpenRouterUsageClient.creditsURL, apiKey)
    if (response.statusCode === 403) return []
    ProviderError.requireSuccess(response, 'openrouter')
    return OpenRouterUsageMapper.creditsLines(response.body)
  }

  /** Disabled and expired keys count too: what they spent before they stopped is still this period's spend. */
  async listedKeysSpend(apiKey: string): Promise<OpenRouterSpend> {
    const total: OpenRouterSpend = new Map()
    for (let page = 0; page < OpenRouterUsageClient.maxKeysPages; page++) {
      const url = `${OpenRouterUsageClient.keysURL}?include_disabled=true&include_expired=true&offset=${page * OpenRouterUsageClient.keysPageSize}`
      const keys = OpenRouterUsageMapper.keysPage(await this.get(url, apiKey))
      for (const key of keys) {
        for (const [window, totals] of key) {
          const sum = total.get(window)
          total.set(window, sum ? UsageTotals.adding(sum, totals) : totals)
        }
      }
      if (keys.length < OpenRouterUsageClient.keysPageSize) return total
    }
    throw ProviderError.invalidResponse
  }

  /** One UTC day when `date` is set, else the last 30 finished UTC days. */
  async activity(apiKey: string, date: Instant | undefined): Promise<HTTPResponse> {
    const day = date === undefined ? '' : `?date=${new Date(date).toISOString().slice(0, 10)}`
    return this.send(OpenRouterUsageClient.activityURL + day, apiKey)
  }

  private async get(urlString: string, apiKey: string): Promise<Uint8Array> {
    const response = await this.send(urlString, apiKey)
    ProviderError.requireSuccess(response, 'openrouter')
    return response.body
  }

  private async send(urlString: string, apiKey: string): Promise<HTTPResponse> {
    if (!URL.canParse(urlString)) throw ProviderError.invalidResponse
    return LoginHTTP.get(urlString, apiKey, this.http, { Accept: 'application/json' })
  }
}
