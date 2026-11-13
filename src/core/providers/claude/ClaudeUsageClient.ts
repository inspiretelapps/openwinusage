import { HTTPRequest, type HTTPClient, type HTTPResponse } from '../../services/HTTPClient'
import { asObject, asString, ProviderParse } from '../../support/ProviderParse'
import { ProviderError } from '../ProviderError'

// Upstream keeps `ClaudeLogin.refresh` in this file; here it lives with the sign-in, in
// `services/BrowserProviderLogins`.

export interface ClaudeAccountProfileAccount {
  uuid: string
}

export interface ClaudeAccountProfileOrganization {
  uuid: string
  /** `organization_type` */
  organizationType?: string
  /** `rate_limit_tier` */
  rateLimitTier?: string
}

export interface ClaudeAccountProfile {
  account: ClaudeAccountProfileAccount
  organization?: ClaudeAccountProfileOrganization
}

/** An optional string field: absent and null read as none, and anything but a string fails the decode. */
function optionalString(value: unknown): { ok: true; value?: string } | { ok: false } {
  if (value === undefined || value === null) return { ok: true }
  return typeof value === 'string' ? { ok: true, value } : { ok: false }
}

function identity(profile: ClaudeAccountProfile): string
function identity(accountUUID: string, organizationUUID: string | undefined): string
function identity(first: ClaudeAccountProfile | string, organizationUUID?: string): string {
  const accountUUID = typeof first === 'string' ? first : first.account.uuid
  const organization = typeof first === 'string' ? organizationUUID : first.organization?.uuid
  return [accountUUID, organization].filter((part): part is string => part !== undefined).join('/')
}

export const ClaudeAccountProfile = {
  /** `JSONDecoder().decode(ClaudeAccountProfile.self, from:)`; undefined when the body is not a profile. */
  decode(body: Uint8Array | string): ClaudeAccountProfile | undefined {
    const object = asObject(ProviderParse.json(body))
    const accountUUID = asString(asObject(object?.account)?.uuid)
    if (!object || accountUUID === undefined) return undefined
    const profile: ClaudeAccountProfile = { account: { uuid: accountUUID } }
    if (object.organization !== undefined && object.organization !== null) {
      const source = asObject(object.organization)
      const uuid = asString(source?.uuid)
      const organizationType = optionalString(source?.organization_type)
      const rateLimitTier = optionalString(source?.rate_limit_tier)
      if (!source || uuid === undefined || !organizationType.ok || !rateLimitTier.ok) return undefined
      const organization: ClaudeAccountProfileOrganization = { uuid }
      if (organizationType.value !== undefined) organization.organizationType = organizationType.value
      if (rateLimitTier.value !== undefined) organization.rateLimitTier = rateLimitTier.value
      profile.organization = organization
    }
    return profile
  },

  /** A profile's identity, or the identity of an account and organization: `account/organization`. */
  identity
}

export class ClaudeUsageClient {
  static readonly usageURL = 'https://api.anthropic.com/api/oauth/usage'
  static readonly profileURL = 'https://api.anthropic.com/api/oauth/profile'
  static readonly resetGrantsURL = 'https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1'

  /** Tracks Claude Code: Anthropic's grants check rejects old versions (`ineligible_reason: cli_version`). */
  static readonly claudeCodeVersion = '2.1.294'

  constructor(readonly httpClient: HTTPClient) {}

  fetchUsage(accessToken: string): Promise<HTTPResponse> {
    return this.sendUsageRequest(ClaudeUsageClient.usageURL, accessToken)
  }

  /**
   * `GET /api/oauth/usage?cedar_ember=1&skip_spend=1`, the exact request Claude Code makes when it checks
   * for a reset to offer. `cedar_ember=1` opts in to Anthropic's one-off usage-limit reset grants (the
   * Rate Limit Resets row), which the plain read returns as `null`; `skip_spend=1` drops the spend
   * figures this request doesn't need. Anthropic rate-limits this variant hard when it's polled, so the
   * runtime asks at most once an hour. Anthropic also decides grant eligibility by client surface: a
   * User-Agent it doesn't recognize as Claude Code comes back `eligible: false,
   * ineligible_reason: "surface"` with no grants.
   */
  fetchResetGrants(accessToken: string): Promise<HTTPResponse> {
    return this.sendUsageRequest(ClaudeUsageClient.resetGrantsURL, accessToken)
  }

  private sendUsageRequest(url: string, accessToken: string): Promise<HTTPResponse> {
    return this.httpClient.send(HTTPRequest.make('GET', url, ClaudeUsageClient.claudeCodeHeaders(accessToken), undefined, 10))
  }

  claimResetGrant(accessToken: string, organizationUUID: string, grantID: string, requestID: string): Promise<HTTPResponse> {
    const body = JSON.stringify({ program: 'cedar_ember', grant_id: grantID, request_id: requestID })
    return this.httpClient.send(
      HTTPRequest.make('POST', ClaudeUsageClient.resetClaimURL(organizationUUID), ClaudeUsageClient.claudeCodeHeaders(accessToken), body, 25)
    )
  }

  static resetClaimURL(organizationUUID: string): string {
    // The usage URL without its last two path components, `/api/`.
    const api = ClaudeUsageClient.usageURL.split('/').slice(0, -2).join('/')
    return `${api}/organizations/${encodeURIComponent(organizationUUID)}/reset_rate_limits`
  }

  private static claudeCodeHeaders(accessToken: string): Record<string, string> {
    return {
      Authorization: `Bearer ${accessToken.trim()}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'anthropic-beta': 'oauth-2025-04-20',
      'User-Agent': `claude-cli/${ClaudeUsageClient.claudeCodeVersion} (external, cli)`
    }
  }

  async fetchProfile(accessToken: string): Promise<HTTPResponse> {
    try {
      return await this.httpClient.send(
        HTTPRequest.make(
          'GET',
          ClaudeUsageClient.profileURL,
          {
            Authorization: `Bearer ${accessToken.trim()}`,
            Accept: 'application/json',
            'anthropic-beta': 'oauth-2025-04-20'
          },
          undefined,
          10
        )
      )
    } catch {
      throw ProviderError.connectionFailed
    }
  }

  static decodeProfile(response: HTTPResponse): ClaudeAccountProfile {
    if (!(response.statusCode >= 200 && response.statusCode < 300)) throw ProviderError.failed(response)
    const profile = ClaudeAccountProfile.decode(response.body)
    if (!profile) throw ProviderError.invalidResponse
    return profile
  }
}
