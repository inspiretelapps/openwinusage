import { HTTPRequest, type HTTPClient, type HTTPResponse } from '../../services/HTTPClient'
import { asArray, asObject, asString, isJSONObject, ProviderParse, utf8 } from '../../support/ProviderParse'
import { ProviderError } from '../ProviderError'
import { AntigravityUsageMapper } from './AntigravityUsageMapper'

// `AntigravityLogin.refresh`, which upstream adds to the login in this file, lives with the login in
// `services/BrowserProviderLogins.ts`.

/** The quota read answered 401: the access token was refused, so a renewed sign-in may read it. */
export class AntigravityUsageClientTokenRefused extends Error {
  constructor() {
    super('TokenRefused')
    this.name = 'AntigravityUsageClientTokenRefused'
  }
}

const isSuccess = (response: HTTPResponse): boolean => response.statusCode >= 200 && response.statusCode < 300

function requiresSubscription(response: HTTPResponse): boolean {
  if (response.statusCode !== 403) return false
  const error = asObject(ProviderParse.jsonObject(response.body)?.error)
  const details = asArray(error?.details)
  if (!details || !details.every(isJSONObject)) return false
  return details.some((detail) => asString(detail.reason) === 'SUBSCRIPTION_REQUIRED')
}

function cloudCodeRequest(url: string, token: string, payload: Uint8Array): HTTPRequest {
  return HTTPRequest.make(
    'POST',
    url,
    {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'User-Agent': AntigravityUsageClient.clientUserAgent
    },
    payload,
    15
  )
}

// Plan and project lookups prefer production.
const cloudCodeURLs = ['https://cloudcode-pa.googleapis.com', 'https://daily-cloudcode-pa.googleapis.com']

/**
 * The Antigravity client's own User-Agent shape (`%s/%s (aidev_client; os_type=…; arch=…)` in its
 * language server). Google marks other callers `UNSUPPORTED_CLIENT` and drops `paidTier`.
 */
function clientUserAgent(): string {
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64'
  const os = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux'
  return `antigravity/2.24.0 (aidev_client; os_type=${os}; arch=${arch})`
}

export class AntigravityUsageClient {
  static readonly unavailableMessage = 'Antigravity usage is temporarily unavailable. Try again shortly.'
  static readonly cloudCodeURLs = cloudCodeURLs
  // Production can return untouched Gemini windows; daily has the active counters.
  // Use production for missing buckets or failed daily reads.
  static readonly quotaSummaryURLs = [...cloudCodeURLs].reverse()
  static readonly loadCodeAssistPath = '/v1internal:loadCodeAssist'
  static readonly quotaSummaryPath = '/v1internal:retrieveUserQuotaSummary'

  static readonly clientUserAgent = clientUserAgent()

  static readonly loadCodeAssistPayload = utf8('{"metadata":{"ideType":"ANTIGRAVITY","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}}')

  http: HTTPClient

  constructor(http: HTTPClient) {
    this.http = http
  }

  /**
   * `loadCodeAssist` with Antigravity's client metadata. Without it the response carries only
   * `allowedTiers` — no `currentTier`/`paidTier` — so the plan can't be read. Each base URL is tried in
   * turn: a 401/403 is an expired sign-in (the same token would fail on the other base); other non-2xx
   * and transport errors fall through to the next base and finally "unavailable".
   */
  async loadCodeAssist(token: string): Promise<Uint8Array> {
    for (const base of AntigravityUsageClient.cloudCodeURLs) {
      const url = base + AntigravityUsageClient.loadCodeAssistPath
      const request = cloudCodeRequest(url, token, AntigravityUsageClient.loadCodeAssistPayload)
      let response: HTTPResponse
      try {
        response = await this.http.send(request)
      } catch {
        continue
      }
      if (ProviderError.isAuthFailure(response)) throw ProviderError.signInExpired('antigravity')
      if (isSuccess(response)) return response.body
    }
    throw ProviderError.unavailable(AntigravityUsageClient.unavailableMessage)
  }

  async quotaSummary(token: string, project: string | undefined): Promise<Uint8Array[]> {
    const body = project === undefined ? {} : { project }
    const payload = utf8(JSON.stringify(body))
    const responses: HTTPResponse[] = []
    let transportError: unknown
    let hasTransportError = false
    for (const [index, base] of AntigravityUsageClient.quotaSummaryURLs.entries()) {
      const url = base + AntigravityUsageClient.quotaSummaryPath
      const request = cloudCodeRequest(url, token, payload)
      let response: HTTPResponse
      try {
        response = await this.http.send(request)
      } catch (error) {
        transportError = error
        hasTransportError = true
        continue
      }
      responses.push(response)
      if (index === 0 && isSuccess(response) && AntigravityUsageMapper.isCompleteSummary(response.body)) break
    }
    if (responses.length === 0 && hasTransportError) throw transportError
    const bodies = responses.filter(isSuccess).map((response) => response.body)
    if (bodies.length > 0) return bodies
    if (responses.some((response) => response.statusCode === 401)) throw new AntigravityUsageClientTokenRefused()
    if (responses.some(requiresSubscription)) {
      const message =
        project === undefined
          ? "Antigravity couldn't find a project with quota access for this account. Try again shortly."
          : 'Google reports no Antigravity quota subscription for this project.'
      throw ProviderError.unavailable(message)
    }
    if (responses.some(ProviderError.isAuthFailure)) throw ProviderError.signInExpired('antigravity')
    const limited = responses.find((response) => response.statusCode === 429)
    if (limited) throw ProviderError.failed(limited)
    throw ProviderError.unavailable(AntigravityUsageClient.unavailableMessage)
  }
}
