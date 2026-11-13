import { randomUUID } from 'node:crypto'
import { Account, AccountCredential, OAuthTokens, ProviderKind, type ProviderAuthMethod } from '../models/Account'
import { NetworkError } from '../models/ProviderSnapshot'
import { AccountProviderRuntime, type TokenGrant } from '../providers/AccountProviderRuntime'
import { ProviderError } from '../providers/ProviderError'
import { CopilotUsageClient } from '../providers/copilot/CopilotUsageClient'
import { GitHubDomain } from '../providers/copilot/GitHubDomain'
import { CursorUsageClient } from '../providers/cursor/CursorUsageClient'
import { DevinLogin } from '../providers/devin/DevinLogin'
import { MuseUsageClient } from '../providers/muse/MuseUsageClient'
import { OllamaUsageMapper } from '../providers/ollama/OllamaUsageMapper'
import { AppInfo } from '../support/AppInfo'
import { AppLog, LogTags, describeError } from '../support/AppLog'
import { ProviderParse, asString, nilIfEmpty, urlFormEncoded, type JSONObject } from '../support/ProviderParse'
import type { Seconds } from '../support/time'
import { MemoryCredentialVault } from './AccountCredentialVault'
import { AntigravityLogin, ClaudeLogin, CodexLogin } from './BrowserProviderLogins'
import { DeviceCodePoller, DeviceCodePollResult } from './DeviceCodePoller'
import { HTTPRequest, type HTTPClient } from './HTTPClient'
import { Decode, LoginError, LoginHTTP, OAuthTokenResponse, URLQuery, cancellable, nextPastedCode } from './OAuthLoginSupport'
import { PKCE } from './PKCE'
import type { LoginPrompt, ProviderLogin } from './ProviderLogin'

type Prompt = (prompt: LoginPrompt) => Promise<void> | void
type LoginResult = { label: string; credential: AccountCredential }

export class CopilotLogin implements ProviderLogin {
  static readonly clientID = atob('SXYxLmI1MDdhMDhjODdlY2ZlOTg=')
  /**
   * The scope Copilot's own sign-in asks for, known to read `/copilot_internal/user`. GitHub's `/user`
   * names the account with any token; whether the quota read works with no scope at all is unverified.
   */
  static readonly scopes = 'read:user'

  constructor(
    readonly http: HTTPClient,
    readonly domain: GitHubDomain = GitHubDomain.github
  ) {}

  async login(prompt: Prompt, _pastedCode: AsyncIterable<string>, signal?: AbortSignal): Promise<LoginResult> {
    try {
      return await this.signIn(prompt, signal)
    } catch (error) {
      if (!(error instanceof NetworkError)) throw error
      const host = GitHubDomain.saved(this.domain)
      if (host === undefined) throw error
      AppLog.warn(LogTags.auth('copilot'), `could not reach ${host}: ${describeError(error)}`)
      throw ProviderError.unavailable(`Couldn’t reach ${host}. Check the address and your connection.`)
    }
  }

  private async signIn(prompt: Prompt, signal: AbortSignal | undefined): Promise<LoginResult> {
    const token = await deviceAuthorization(
      'GitHub',
      GitHubDomain.webURL(this.domain, '/login/device/code'),
      GitHubDomain.webURL(this.domain, '/login/oauth/access_token'),
      CopilotLogin.clientID,
      CopilotLogin.scopes,
      'GitHub device sign-in was denied.',
      this.http,
      prompt,
      { 'User-Agent': AppInfo.name },
      signal
    )
    const profile = await cancellable(
      signal,
      LoginHTTP.get(GitHubDomain.apiURL(this.domain, '/user'), token.accessToken, this.http, {
        Accept: 'application/vnd.github+json',
        'User-Agent': AppInfo.name,
        'X-GitHub-Api-Version': '2022-11-28'
      })
    )
    const user = LoginHTTP.decode(decodeGitHubUser, profile)
    const userID = user.id === undefined ? user.login : String(user.id)
    let identity = `github:${userID}`
    const host = GitHubDomain.saved(this.domain)
    if (host !== undefined) {
      await cancellable(signal, this.requireSeat(token.accessToken, user.login))
      // The same user id on two domains is two accounts.
      identity = `github:${host}:${userID}`
    }
    return {
      label: user.login,
      credential: AccountCredential.oauth(OAuthTokens.make(token.accessToken, undefined, undefined, { [OAuthTokens.identityKey]: identity }))
    }
  }

  /** An enterprise sign-in reads usage once, so an account without a Copilot seat is never added. */
  private async requireSeat(token: string, login: string): Promise<void> {
    const usage = await new CopilotUsageClient(this.http).fetchUsage(token, this.domain)
    if (usage.statusCode >= 200 && usage.statusCode < 300) return
    const host = GitHubDomain.host(this.domain)
    AppLog.warn(LogTags.auth('copilot'), `seat check on ${host} failed with HTTP ${usage.statusCode}`)
    if (ProviderError.isAuthFailure(usage) || usage.statusCode === 404) {
      throw ProviderError.unavailable(`${login} has no Copilot seat on ${host}. Ask your GitHub admin for one, then try again.`)
    }
    throw ProviderError.failed(usage)
  }
}

export class GrokLogin implements ProviderLogin {
  static readonly clientID = 'b1a00492-073a-47ea-816f-4c329264a828'
  static readonly tokenURL = 'https://auth.x.ai/oauth2/token'
  static readonly scopes = 'openid email offline_access grok-cli:access'

  constructor(readonly http: HTTPClient) {}

  async login(prompt: Prompt, _pastedCode: AsyncIterable<string>, signal?: AbortSignal): Promise<LoginResult> {
    const token = await deviceAuthorization(
      'xAI',
      'https://auth.x.ai/oauth2/device/code',
      GrokLogin.tokenURL,
      GrokLogin.clientID,
      GrokLogin.scopes,
      'xAI device sign-in failed.',
      this.http,
      prompt,
      {},
      signal
    )
    const claims = decodeGrokIDClaims(token.accessToken)
    const identity = claims?.sub ?? claims?.email
    return {
      label: claims?.email ?? 'Grok Account',
      credential: AccountCredential.oauth(
        OAuthTokenResponse.tokens(token, identity === undefined ? {} : { [OAuthTokens.identityKey]: identity })
      )
    }
  }

  /** Upstream keeps this in `GrokUsageClient.swift`, as an extension of the login. */
  static readonly refresh: TokenGrant = async (refreshToken, http, now) => {
    const body =
      'grant_type=refresh_token' +
      `&client_id=${urlFormEncoded(GrokLogin.clientID)}` +
      `&refresh_token=${urlFormEncoded(refreshToken)}`

    const response = await http.send(
      HTTPRequest.make('POST', GrokLogin.tokenURL, { 'Content-Type': 'application/x-www-form-urlencoded' }, body, 15)
    )
    return OAuthTokenResponse.grant(OAuthTokenResponse.renewal(response, 'grok'), now)
  }
}

/**
 * Muse Code's device sign-in, under the Muse CLI's own public client: Meta registers no other clients.
 * It sends no scope: the usage read needs none, and the device endpoint refuses `openid`. The sign-in
 * returns a `dca:` token with no refresh token, and the account takes the email Muse reports for it.
 */
export class MuseLogin implements ProviderLogin {
  static readonly clientID = '1031625952748946'

  constructor(readonly http: HTTPClient) {}

  async login(prompt: Prompt, _pastedCode: AsyncIterable<string>, signal?: AbortSignal): Promise<LoginResult> {
    const token = await deviceAuthorization(
      'Meta',
      'https://auth.meta.com/oidc/device/authorization/',
      'https://auth.meta.com/oidc/device/token/',
      MuseLogin.clientID,
      undefined,
      'Meta device sign-in was denied.',
      this.http,
      prompt,
      {},
      signal
    )
    const account = await cancellable(signal, new MuseUsageClient(this.http).account(token.accessToken))
    const email = nilIfEmpty(account.email === undefined ? undefined : trimmingWhitespaces(account.email))
    return {
      label: email ?? ProviderKind.displayName('muse'),
      credential: AccountCredential.oauth(
        OAuthTokens.make(token.accessToken, undefined, undefined, email === undefined ? {} : { [OAuthTokens.identityKey]: `muse:${email}` })
      )
    }
  }
}

export class CursorLogin implements ProviderLogin {
  constructor(readonly http: HTTPClient) {}

  async login(prompt: Prompt, _pastedCode: AsyncIterable<string>, signal?: AbortSignal): Promise<LoginResult> {
    const pkce = PKCE.generate()
    const uuid = randomUUID()
    const authorizeURL = URLQuery.url('https://cursor.com/loginDeepControl', [
      ['challenge', pkce.challenge],
      ['uuid', uuid],
      ['mode', 'login'],
      ['redirectTarget', 'cli']
    ])
    await cancellable(signal, prompt({ type: 'browser', url: authorizeURL, acceptsPastedCode: false }))
    const http = this.http
    const token = await DeviceCodePoller.poll<CursorTokenResponse>(
      2,
      300,
      async () => {
        const url = URLQuery.url('https://api2.cursor.sh/auth/poll', [
          ['uuid', uuid],
          ['verifier', pkce.verifier]
        ])
        const response = await LoginHTTP.get(url, undefined, http)
        if (response.statusCode >= 200 && response.statusCode < 300) {
          const token = decodeCursorTokenResponse(response.body)
          if (token && token.accessToken.length > 0 && token.refreshToken.length > 0) return DeviceCodePollResult.complete(token)
        }
        if (response.statusCode === 404 || response.statusCode === 202) return DeviceCodePollResult.pending
        return DeviceCodePollResult.failed('Cursor sign-in failed.')
      },
      undefined,
      undefined,
      signal
    )
    const userID = CursorUsageClient.session(token.accessToken)?.userID
    return {
      label: (await this.profileName(token.accessToken, signal)) ?? 'Cursor Account',
      credential: AccountCredential.oauth(
        OAuthTokens.make(
          token.accessToken,
          token.refreshToken,
          ProviderParse.jwtExpiry(token.accessToken),
          userID === undefined ? {} : { [OAuthTokens.identityKey]: `cursor:${userID}` }
        )
      )
    }
  }

  private async profileName(accessToken: string, signal: AbortSignal | undefined): Promise<string | undefined> {
    try {
      const response = await cancellable(signal, new CursorUsageClient(this.http).fetchProfile(accessToken))
      if (!response) throw LoginError.invalidResponse
      const profile = LoginHTTP.decode(decodeCursorProfile, response)
      return [profile.email, profile.name].find((value) => value !== undefined && value.length > 0)
    } catch (error) {
      if (LoginError.is(error, 'cancelled')) throw error
      AppLog.warn(LogTags.auth('cursor'), `profile read failed, naming the account Cursor Account: ${describeError(error)}`)
      return undefined
    }
  }
}

export class APIKeyLogin implements ProviderLogin {
  constructor(
    readonly kind: ProviderKind,
    readonly http: HTTPClient
  ) {}

  async login(_prompt: Prompt, pastedCode: AsyncIterable<string>, signal?: AbortSignal): Promise<LoginResult> {
    const value = await nextPastedCode(pastedCode, signal)
    if (value === undefined) throw LoginError.cancelled
    const key = value.trim()
    if (key.length === 0) throw LoginError.invalidCode
    const displayName = ProviderKind.displayName(this.kind)
    const account = Account.make({ kind: this.kind, label: displayName })
    // The new key proves itself with one usage read. The runtime's store holds nothing for this account.
    const runtime = new AccountProviderRuntime(account, new MemoryCredentialVault(), this.http)
    try {
      await cancellable(signal, runtime.readSnapshot(AccountCredential.apiKey(key)))
    } catch (error) {
      if (ProviderError.is(error, 'keyRejected')) throw ProviderError.unavailable(error.case.message)
      throw error
    }
    if (this.kind !== 'ollama') return { label: displayName, credential: AccountCredential.apiKey(key) }
    const accountBody = runtime.planBodyRead.value
    const email = accountBody === undefined ? undefined : OllamaUsageMapper.email(accountBody)
    if (email === undefined) {
      AppLog.warn(LogTags.auth('ollama'), 'account read reported no email, naming the account Ollama')
      return { label: displayName, credential: AccountCredential.apiKey(key) }
    }
    return { label: email, credential: AccountCredential.apiKey(key) }
  }
}

/** Adds an organization's Copilot billing as its own account, checked with one read of the report. */
export class CopilotOrganizationLogin implements ProviderLogin {
  constructor(
    readonly organization: string,
    readonly http: HTTPClient
  ) {}

  async login(_prompt: Prompt, pastedCode: AsyncIterable<string>, signal?: AbortSignal): Promise<LoginResult> {
    const value = await nextPastedCode(pastedCode, signal)
    if (value === undefined) throw LoginError.cancelled
    const token = value.trim()
    if (token.length === 0) throw LoginError.invalidCode
    try {
      await cancellable(signal, new CopilotUsageClient(this.http).organizationUsage(this.organization, token))
    } catch (error) {
      if (ProviderError.is(error, 'keyRejected')) throw ProviderError.unavailable(error.case.message)
      throw error
    }
    return { label: this.organization, credential: AccountCredential.apiKey(token) }
  }
}

export const ProviderLoginCatalog = {
  /**
   * The HTTP client a sign-in uses when `login` is given none: the port of the logins' default
   * `URLSessionHTTPClient()`. The app sets it at launch to the client that applies the user's proxy.
   */
  http: undefined as HTTPClient | undefined,

  login(kind: ProviderKind, method: ProviderAuthMethod, organization: string, domain: GitHubDomain, http?: HTTPClient): ProviderLogin {
    const client = http ?? ProviderLoginCatalog.http
    if (!client) throw new Error('ProviderLoginCatalog.http is not set: pass an HTTP client or set it at launch.')
    return ProviderLoginCatalog.make(kind, method, organization, domain, client)
  },

  make(kind: ProviderKind, method: ProviderAuthMethod, organization: string, domain: GitHubDomain, http: HTTPClient): ProviderLogin {
    if (method.type === 'organizationToken') return new CopilotOrganizationLogin(organization, http)
    switch (kind) {
      case 'claude':
        return new ClaudeLogin(http)
      case 'codex':
        return new CodexLogin(http)
      case 'cursor':
        return new CursorLogin(http)
      case 'antigravity':
        return new AntigravityLogin(http)
      case 'copilot':
        return new CopilotLogin(http, domain)
      case 'devin':
        return new DevinLogin(http)
      case 'grok':
        return new GrokLogin(http)
      case 'muse':
        return new MuseLogin(http)
      case 'ollama':
      case 'opencode':
      case 'openrouter':
      case 'zai':
        return new APIKeyLogin(kind, http)
    }
  }
}

/** A link the device sign-in may open: `https` with a host. */
function isHTTPSLink(text: string): boolean {
  if (!text.startsWith('https://')) return false
  try {
    return new URL(text).hostname.length > 0
  } catch {
    return false
  }
}

/** `trimmingCharacters(in: .whitespaces)`: spaces and tabs, not line breaks. */
function trimmingWhitespaces(text: string): string {
  return text.replace(/^[\t\p{Zs}]+|[\t\p{Zs}]+$/gu, '')
}

async function deviceAuthorization(
  provider: string,
  startURL: string,
  tokenURL: string,
  clientID: string,
  scopes: string | undefined,
  deniedMessage: string,
  http: HTTPClient,
  prompt: Prompt,
  headers: Record<string, string> = {},
  signal?: AbortSignal
): Promise<OAuthTokenResponse> {
  const fields: Record<string, string> = { client_id: clientID }
  if (scopes !== undefined) fields.scope = scopes
  const start = await cancellable(signal, LoginHTTP.postForm(startURL, fields, http, headers))
  const device = LoginHTTP.decode(decodeDeviceCode, start)
  const verificationURL = [device.verificationURIComplete, device.verificationURI].find(
    (candidate): candidate is string => candidate !== undefined && isHTTPSLink(candidate)
  )
  if (verificationURL === undefined) throw LoginError.invalidResponse
  await cancellable(signal, prompt({ type: 'deviceCode', userCode: device.userCode, verificationURL }))
  return DeviceCodePoller.poll<OAuthTokenResponse>(
    device.interval ?? 5,
    device.expiresIn,
    async () => {
      const response = await LoginHTTP.postForm(
        tokenURL,
        {
          client_id: clientID,
          device_code: device.deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
        },
        http,
        headers
      )
      const token = OAuthTokenResponse.decodeBody(response.body)
      if (token) return DeviceCodePollResult.complete(token)
      switch (asString(ProviderParse.jsonObject(response.body)?.error)) {
        case 'authorization_pending':
          return DeviceCodePollResult.pending
        case 'slow_down':
          return DeviceCodePollResult.slowDown
        case 'expired_token':
          return DeviceCodePollResult.failed(`${provider} device sign-in expired.`)
        case 'access_denied':
          return DeviceCodePollResult.failed(deniedMessage)
        default:
          return DeviceCodePollResult.failed(`${provider} device sign-in failed.`)
      }
    },
    undefined,
    undefined,
    signal
  )
}

interface DeviceCode {
  deviceCode: string
  userCode: string
  verificationURI: string
  verificationURIComplete?: string
  expiresIn: number
  interval?: Seconds
}

function decodeDeviceCode(json: JSONObject): DeviceCode {
  const device: DeviceCode = {
    deviceCode: Decode.string(json, 'device_code'),
    userCode: Decode.string(json, 'user_code'),
    verificationURI: Decode.string(json, 'verification_uri'),
    expiresIn: Decode.int(json, 'expires_in')
  }
  const verificationURIComplete = Decode.optionalString(json, 'verification_uri_complete')
  const interval = Decode.optionalNumber(json, 'interval')
  if (verificationURIComplete !== undefined) device.verificationURIComplete = verificationURIComplete
  if (interval !== undefined) device.interval = interval
  return device
}

interface GitHubUser {
  id?: number
  login: string
}

function decodeGitHubUser(json: JSONObject): GitHubUser {
  const user: GitHubUser = { login: Decode.string(json, 'login') }
  const id = Decode.optionalInt(json, 'id')
  if (id !== undefined) user.id = id
  return user
}

interface CursorTokenResponse {
  accessToken: string
  refreshToken: string
}

/** `try? LoginHTTP.decode(CursorTokenResponse.self, from: response)` */
function decodeCursorTokenResponse(body: Uint8Array): CursorTokenResponse | undefined {
  try {
    const json = Decode.object(body)
    return { accessToken: Decode.string(json, 'accessToken'), refreshToken: Decode.string(json, 'refreshToken') }
  } catch {
    return undefined
  }
}

interface CursorProfile {
  email?: string
  name?: string
}

function decodeCursorProfile(json: JSONObject): CursorProfile {
  const profile: CursorProfile = {}
  const email = Decode.optionalString(json, 'email')
  const name = Decode.optionalString(json, 'name')
  if (email !== undefined) profile.email = email
  if (name !== undefined) profile.name = name
  return profile
}

interface GrokIDClaims {
  sub?: string
  email?: string
}

/** `ProviderParse.jwtPayloadData(token).flatMap { try? JSONDecoder().decode(GrokIDClaims.self, from: $0) }` */
function decodeGrokIDClaims(token: string): GrokIDClaims | undefined {
  const payload = ProviderParse.jwtPayloadText(token)
  if (payload === undefined) return undefined
  try {
    const json = Decode.object(payload)
    const claims: GrokIDClaims = {}
    const sub = Decode.optionalString(json, 'sub')
    const email = Decode.optionalString(json, 'email')
    if (sub !== undefined) claims.sub = sub
    if (email !== undefined) claims.email = email
    return claims
  } catch {
    return undefined
  }
}
