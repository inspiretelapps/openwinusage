import { HTTPRequest, type HTTPClient, type HTTPResponse } from '../../services/HTTPClient'
import { LoginHTTP } from '../../services/OAuthLoginSupport'
import { asString, ProviderParse, utf8 } from '../../support/ProviderParse'
import type { Instant } from '../../support/time'

export interface CursorSession {
  userID: string
  sessionToken: string
}

const unreservedQuery = /[A-Za-z0-9\-._~!$'()*+,/:;?@]/
const encoder = new TextEncoder()

/**
 * `URLQueryItem(name:value:)` as `URLComponents` writes its value: the characters a query may hold
 * pass through, except `&` and `=`, which would end the item.
 */
function queryItemValue(text: string): string {
  let out = ''
  for (const byte of encoder.encode(text)) {
    const char = String.fromCharCode(byte)
    out += byte < 0x80 && unreservedQuery.test(char) ? char : '%' + byte.toString(16).toUpperCase().padStart(2, '0')
  }
  return out
}

export class CursorUsageClient {
  static readonly usageURL = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage'
  static readonly grokBotUsageURL = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetSandUsageStatus'
  static readonly planURL = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo'
  static readonly refreshURL = 'https://api2.cursor.sh/oauth/token'
  static readonly creditsURL = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCreditGrantsBalance'
  static readonly restUsageURL = 'https://cursor.com/api/usage'
  static readonly usageSummaryURL = 'https://cursor.com/api/usage-summary'
  static readonly stripeURL = 'https://cursor.com/api/auth/stripe'
  static readonly profileURL = 'https://cursor.com/api/auth/me'
  static readonly usageEventsURL = 'https://cursor.com/api/dashboard/get-filtered-usage-events'
  static readonly clientID = 'KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB'

  http: HTTPClient

  constructor(http: HTTPClient) {
    this.http = http
  }

  async refreshToken(refreshToken: string): Promise<HTTPResponse> {
    return LoginHTTP.postJSON(
      CursorUsageClient.refreshURL,
      {
        grant_type: 'refresh_token',
        client_id: CursorUsageClient.clientID,
        refresh_token: refreshToken
      },
      this.http
    )
  }

  async fetchUsage(accessToken: string): Promise<HTTPResponse> {
    return this.connectPost(CursorUsageClient.usageURL, accessToken)
  }

  async fetchGrokBotUsage(accessToken: string): Promise<HTTPResponse> {
    return this.connectPost(CursorUsageClient.grokBotUsageURL, accessToken)
  }

  async fetchPlan(accessToken: string): Promise<HTTPResponse> {
    return this.connectPost(CursorUsageClient.planURL, accessToken)
  }

  async fetchCredits(accessToken: string): Promise<HTTPResponse> {
    return this.connectPost(CursorUsageClient.creditsURL, accessToken)
  }

  async fetchRequestBasedUsage(accessToken: string): Promise<HTTPResponse | undefined> {
    const session = CursorUsageClient.session(accessToken)
    if (!session) return undefined
    const url = `${CursorUsageClient.restUsageURL}?user=${queryItemValue(session.userID)}`

    return this.http.send(HTTPRequest.make('GET', url, { Cookie: `WorkosCursorSessionToken=${session.sessionToken}` }, undefined, 10))
  }

  async fetchUsageSummary(accessToken: string): Promise<HTTPResponse | undefined> {
    return this.sessionGet(CursorUsageClient.usageSummaryURL, accessToken)
  }

  async fetchStripeBalance(accessToken: string): Promise<HTTPResponse | undefined> {
    return this.sessionGet(CursorUsageClient.stripeURL, accessToken)
  }

  async fetchProfile(accessToken: string): Promise<HTTPResponse | undefined> {
    return this.sessionGet(CursorUsageClient.profileURL, accessToken)
  }

  /** One page of the usage events between `start` and `end`, both inclusive, as the account's Usage page lists them. */
  async fetchUsageEventsPage(
    accessToken: string,
    start: Instant,
    end: Instant,
    page: number,
    pageSize: number
  ): Promise<HTTPResponse | undefined> {
    const session = CursorUsageClient.session(accessToken)
    if (!session) return undefined
    const body = {
      startDate: String(Math.trunc(start)),
      endDate: String(Math.trunc(end)),
      page,
      pageSize
    }
    return this.http.send(
      HTTPRequest.make(
        'POST',
        CursorUsageClient.usageEventsURL,
        {
          Cookie: `WorkosCursorSessionToken=${session.sessionToken}`,
          'Content-Type': 'application/json',
          Origin: 'https://cursor.com'
        },
        utf8(JSON.stringify(body)),
        15
      )
    )
  }

  private async sessionGet(url: string, accessToken: string): Promise<HTTPResponse | undefined> {
    const session = CursorUsageClient.session(accessToken)
    if (!session) return undefined
    return this.http.send(HTTPRequest.make('GET', url, { Cookie: `WorkosCursorSessionToken=${session.sessionToken}` }, undefined, 10))
  }

  private async connectPost(url: string, accessToken: string): Promise<HTTPResponse> {
    return this.http.send(
      HTTPRequest.make(
        'POST',
        url,
        {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1'
        },
        utf8('{}'),
        10
      )
    )
  }

  static session(accessToken: string): CursorSession | undefined {
    const subject = asString(ProviderParse.jwtPayload(accessToken)?.sub)
    if (subject === undefined) return undefined
    const trimmedSubject = subject.trim()
    if (trimmedSubject.length === 0) return undefined
    const parts = trimmedSubject.split('|')
    const userID = parts.length > 1 ? parts[1] : parts[0]
    if (userID.length === 0) return undefined
    return { userID, sessionToken: `${userID}%3A%3A${accessToken}` }
  }
}
