import { HTTPRequest, type HTTPClient, type HTTPResponse } from '../../services/HTTPClient'
import { ProviderError } from '../ProviderError'

export class OllamaUsageClient {
  static readonly host = 'https://ollama.com'
  static readonly balancePath = '/api/balance'
  static readonly accountPath = '/api/me'
  static readonly usagePath = '/api/usage'

  readonly http: HTTPClient

  constructor(http: HTTPClient) {
    this.http = http
  }

  async fetchBalance(apiKey: string): Promise<HTTPResponse> {
    return this.send('GET', OllamaUsageClient.balancePath, apiKey)
  }

  /** `range` is 7d or 30d: whole UTC days back from today, plus today so far. */
  async fetchUsage(apiKey: string, range: string): Promise<HTTPResponse> {
    return this.send('GET', OllamaUsageClient.usagePath + `?range=${range}&group_by=model`, apiKey)
  }

  async fetchAccount(apiKey: string): Promise<HTTPResponse> {
    return this.send('POST', OllamaUsageClient.accountPath, apiKey)
  }

  private async send(method: string, path: string, apiKey: string): Promise<HTTPResponse> {
    const url = OllamaUsageClient.host + path
    if (!URL.canParse(url)) throw ProviderError.invalidResponse
    return this.http.send(
      HTTPRequest.make(
        method,
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
