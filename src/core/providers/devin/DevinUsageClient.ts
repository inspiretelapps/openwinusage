import type { OAuthTokens } from '../../models/Account'
import { HTTPRequest, type HTTPClient, type HTTPResponse } from '../../services/HTTPClient'

/** `URL.appending(path:)`: adds `path` under the URL's own path, with one slash between them. */
function appendingPath(base: string, path: string): string {
  try {
    const url = new URL(base)
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/${path}`
    return url.href
  } catch {
    return `${base.replace(/\/+$/, '')}/${path}`
  }
}

export class DevinUsageClient {
  static readonly defaultAPIServerURL = 'https://server.codeium.com'
  static readonly apiServerURLKey = 'api_server_url'
  static readonly cloudCompatVersion = '1.108.2'

  readonly http: HTTPClient

  constructor(http: HTTPClient) {
    this.http = http
  }

  async fetchUserStatus(tokens: OAuthTokens): Promise<HTTPResponse> {
    const saved = tokens.extras[DevinUsageClient.apiServerURLKey]
    const apiServerURL = saved !== undefined && saved.length > 0 ? saved : DevinUsageClient.defaultAPIServerURL
    const body = {
      metadata: {
        apiKey: tokens.accessToken,
        ideName: 'devin',
        ideVersion: DevinUsageClient.cloudCompatVersion,
        extensionName: 'devin',
        extensionVersion: DevinUsageClient.cloudCompatVersion,
        locale: 'en'
      }
    }
    return this.http.send(
      HTTPRequest.make(
        'POST',
        appendingPath(apiServerURL, 'exa.seat_management_pb.SeatManagementService/GetUserStatus'),
        {
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1'
        },
        JSON.stringify(body),
        15
      )
    )
  }
}
