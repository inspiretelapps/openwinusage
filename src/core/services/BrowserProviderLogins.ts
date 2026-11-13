import { randomUUID } from 'node:crypto'
import { AccountCredential, OAuthTokens } from '../models/Account'
import type { TokenGrant } from '../providers/AccountProviderRuntime'
import { ClaudeAccountProfile, ClaudeUsageClient } from '../providers/claude/ClaudeUsageClient'
import { AppLog, LogTags, describeError } from '../support/AppLog'
import { ProviderParse, asObject, asString, urlFormEncoded, type JSONObject } from '../support/ProviderParse'
import { addSeconds } from '../support/time'
import { DeviceCodePoller, DeviceCodePollResult } from './DeviceCodePoller'
import { HTTPRequest, type HTTPClient } from './HTTPClient'
import { LoopbackCallbackServer } from './LoopbackCallbackServer'
import { Decode, LoginError, LoginHTTP, OAuthGrant, OAuthTokenResponse, authorizeInBrowser, cancellable } from './OAuthLoginSupport'
import { PKCE } from './PKCE'
import type { LoginPrompt, ProviderLogin } from './ProviderLogin'

type Prompt = (prompt: LoginPrompt) => Promise<void> | void
type LoginResult = { label: string; credential: AccountCredential }

export class ClaudeLogin implements ProviderLogin {
  static readonly clientID = atob('OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl')
  static readonly authorizeURL = 'https://claude.ai/oauth/authorize'
  static readonly tokenURL = 'https://platform.claude.com/v1/oauth/token'
  /**
   * `/api/oauth/usage` and `/api/oauth/profile` gate on `user:profile` and nothing else (Anthropic answers
   * a token without it with "OAuth token does not meet scope requirement user:profile"). The refresh
   * grant sends the same string, so a refreshed token never carries more than the sign-in granted.
   */
  static readonly scopes = 'user:profile'

  constructor(readonly http: HTTPClient) {}

  async login(prompt: Prompt, pastedCode: AsyncIterable<string>, signal?: AbortSignal): Promise<LoginResult> {
    const pkce = PKCE.generate()
    const state = randomUUID()
    const server = await LoopbackCallbackServer.start(state)
    const code = await authorizeInBrowser(
      ClaudeLogin.authorizeURL,
      ClaudeLogin.clientID,
      ClaudeLogin.scopes,
      state,
      pkce,
      server,
      prompt,
      pastedCode,
      [['code', 'true']],
      signal
    )
    const response = await cancellable(
      signal,
      LoginHTTP.postJSON(
        ClaudeLogin.tokenURL,
        {
          grant_type: 'authorization_code',
          client_id: ClaudeLogin.clientID,
          code,
          state,
          redirect_uri: server.redirectURI,
          code_verifier: pkce.verifier
        },
        this.http
      )
    )
    const token = LoginHTTP.decode(OAuthTokenResponse.decode, response)
    let info: ClaudeProfileResponse
    try {
      const profile = await cancellable(signal, LoginHTTP.get(ClaudeUsageClient.profileURL, token.accessToken, this.http))
      info = LoginHTTP.decode(decodeClaudeProfileResponse, profile)
    } catch (error) {
      if (LoginError.is(error, 'cancelled')) throw error
      AppLog.error(LogTags.auth('claude'), `profile read failed after the token exchange: ${describeError(error)}`)
      throw LoginError.failed('Claude didn’t return your profile. Click Try Again to sign in again.')
    }
    const identity = ClaudeAccountProfile.identity(info.account.uuid, info.organization?.uuid)
    return {
      label: info.account.email ?? info.email ?? 'Claude Account',
      credential: AccountCredential.oauth(OAuthTokenResponse.tokens(token, { [OAuthTokens.identityKey]: identity }))
    }
  }

  /** Upstream keeps this in `ClaudeUsageClient.swift`, as an extension of the login. */
  static readonly refresh: TokenGrant = async (refreshToken, http, now) => {
    const response = await LoginHTTP.postJSON(
      ClaudeLogin.tokenURL,
      {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: ClaudeLogin.clientID,
        scope: ClaudeLogin.scopes
      },
      http
    )
    return OAuthTokenResponse.grant(OAuthTokenResponse.renewal(response, 'claude'), now)
  }
}

export class CodexLogin implements ProviderLogin {
  static readonly clientID = 'app_EMoamEEZ73f0CkXaXp7hrann'
  static readonly authorizeURL = 'https://auth.openai.com/oauth/authorize'
  static readonly tokenURL = 'https://auth.openai.com/oauth/token'
  static readonly scopes = 'openid profile email offline_access'

  constructor(readonly http: HTTPClient) {}

  async login(prompt: Prompt, pastedCode: AsyncIterable<string>, signal?: AbortSignal): Promise<LoginResult> {
    const pkce = PKCE.generate()
    const state = randomUUID()
    let server: LoopbackCallbackServer
    try {
      server = await LoopbackCallbackServer.start(state, 1455, '/auth/callback')
    } catch {
      return this.deviceLogin(prompt, signal)
    }
    const code = await authorizeInBrowser(
      CodexLogin.authorizeURL,
      CodexLogin.clientID,
      CodexLogin.scopes,
      state,
      pkce,
      server,
      prompt,
      pastedCode,
      [
        ['id_token_add_organizations', 'true'],
        ['codex_cli_simplified_flow', 'true'],
        ['originator', 'pi']
      ],
      signal
    )
    return this.exchange(code, pkce.verifier, server.redirectURI, signal)
  }

  private async deviceLogin(prompt: Prompt, signal: AbortSignal | undefined): Promise<LoginResult> {
    const deviceURL = 'https://auth.openai.com/api/accounts/deviceauth/usercode'
    const start = await cancellable(signal, LoginHTTP.postJSON(deviceURL, { client_id: CodexLogin.clientID }, this.http))
    const device = LoginHTTP.decode(decodeCodexDeviceStart, start)
    const verifyURL = 'https://auth.openai.com/codex/device'
    await cancellable(signal, prompt({ type: 'deviceCode', userCode: device.userCode, verificationURL: verifyURL }))
    const interval = ProviderParse.number(ProviderParse.jsonObject(start.body)?.interval) ?? 5
    const http = this.http
    const deviceToken = await DeviceCodePoller.poll<CodexDeviceToken>(
      interval,
      900,
      async () => {
        const url = 'https://auth.openai.com/api/accounts/deviceauth/token'
        const response = await LoginHTTP.postJSON(url, { device_auth_id: device.deviceAuthID, user_code: device.userCode }, http)
        if (response.statusCode >= 200 && response.statusCode < 300) {
          return DeviceCodePollResult.complete(LoginHTTP.decode(decodeCodexDeviceToken, response))
        }
        if (response.statusCode === 403 || response.statusCode === 404) return DeviceCodePollResult.pending
        const error = asString(ProviderParse.jsonObject(response.body)?.error) ?? ''
        if (error === 'deviceauth_authorization_pending') return DeviceCodePollResult.pending
        if (error === 'slow_down') return DeviceCodePollResult.slowDown
        return DeviceCodePollResult.failed(error === 'expired_token' ? 'Device sign-in expired.' : 'Device sign-in failed.')
      },
      undefined,
      undefined,
      signal
    )
    return this.exchange(deviceToken.authorizationCode, deviceToken.codeVerifier, 'https://auth.openai.com/deviceauth/callback', signal)
  }

  private async exchange(code: string, verifier: string, redirectURI: string, signal: AbortSignal | undefined): Promise<LoginResult> {
    const response = await cancellable(
      signal,
      LoginHTTP.postForm(
        CodexLogin.tokenURL,
        {
          grant_type: 'authorization_code',
          client_id: CodexLogin.clientID,
          code,
          code_verifier: verifier,
          redirect_uri: redirectURI
        },
        this.http
      )
    )
    const token = LoginHTTP.decode(OAuthTokenResponse.decode, response)
    const auth = asObject(ProviderParse.jwtPayload(token.accessToken)?.['https://api.openai.com/auth'])
    const accountID = asString(auth?.chatgpt_account_id)
    const email = token.idToken === undefined ? undefined : asString(ProviderParse.jwtPayload(token.idToken)?.email)
    const extras: Record<string, string> = {}
    if (accountID !== undefined) extras.chatgpt_account_id = accountID
    if (accountID !== undefined && email !== undefined) extras[OAuthTokens.identityKey] = `${accountID}/${email}`
    return { label: email ?? 'ChatGPT Account', credential: AccountCredential.oauth(OAuthTokenResponse.tokens(token, extras)) }
  }

  /** Upstream keeps this in `CodexUsageClient.swift`, as an extension of the login. */
  static readonly refresh: TokenGrant = async (refreshToken, http) => {
    const body =
      'grant_type=refresh_token' +
      `&client_id=${urlFormEncoded(CodexLogin.clientID)}` +
      `&refresh_token=${urlFormEncoded(refreshToken)}`

    const response = await http.send(
      HTTPRequest.make('POST', CodexLogin.tokenURL, { 'Content-Type': 'application/x-www-form-urlencoded' }, body, 15)
    )
    const token = OAuthTokenResponse.renewal(response, 'codex')
    return OAuthGrant.make(token.accessToken, token.refreshToken, ProviderParse.jwtExpiry(token.accessToken))
  }
}

export class AntigravityLogin implements ProviderLogin {
  /**
   * Google OAuth "installed application" client credentials, the pair the Antigravity app ships with.
   * Google does not treat an installed-app client's "secret" as confidential (it is in every copy of
   * the client), and the refresh-token grant requires it, so committing it is an accepted trade-off.
   */
  static readonly clientID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com'
  static readonly clientSecret = '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'
  static readonly tokenURL = 'https://oauth2.googleapis.com/token'
  /**
   * Cloud Code (`loadCodeAssist`, `retrieveUserQuotaSummary`) is a Google Cloud API and takes
   * `cloud-platform`; `userinfo.email` names the account. The Antigravity app also asks for
   * `userinfo.profile`, `cclog`, and `experimentsandconfigs`, which the quota reads never use.
   */
  static readonly scopes = 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email'

  constructor(readonly http: HTTPClient) {}

  async login(prompt: Prompt, pastedCode: AsyncIterable<string>, signal?: AbortSignal): Promise<LoginResult> {
    const pkce = PKCE.generate()
    const state = randomUUID()
    const server = await LoopbackCallbackServer.start(state, 51121, '/oauth-callback')
    const code = await authorizeInBrowser(
      'https://accounts.google.com/o/oauth2/v2/auth',
      AntigravityLogin.clientID,
      AntigravityLogin.scopes,
      state,
      pkce,
      server,
      prompt,
      pastedCode,
      [
        ['access_type', 'offline'],
        ['prompt', 'consent']
      ],
      signal
    )
    const response = await cancellable(
      signal,
      LoginHTTP.postForm(
        AntigravityLogin.tokenURL,
        {
          client_id: AntigravityLogin.clientID,
          client_secret: AntigravityLogin.clientSecret,
          code,
          grant_type: 'authorization_code',
          redirect_uri: server.redirectURI,
          code_verifier: pkce.verifier
        },
        this.http
      )
    )
    const token = LoginHTTP.decode(OAuthTokenResponse.decode, response)
    const userInfoURL = 'https://www.googleapis.com/oauth2/v1/userinfo?alt=json'
    const userInfo = await cancellable(signal, LoginHTTP.get(userInfoURL, token.accessToken, this.http))
    let user: GoogleUserInfo | undefined
    try {
      user = LoginHTTP.decode(decodeGoogleUserInfo, userInfo)
    } catch {
      user = undefined
    }
    const identity = user?.id ?? user?.email
    return {
      label: user?.email ?? 'Google Account',
      credential: AccountCredential.oauth(
        OAuthTokenResponse.tokens(token, identity === undefined ? {} : { [OAuthTokens.identityKey]: identity })
      )
    }
  }

  /** Upstream keeps this in `AntigravityUsageClient.swift`, as an extension of the login. */
  static readonly refresh: TokenGrant = async (refreshToken, http, now) => {
    const form = [
      `client_id=${urlFormEncoded(AntigravityLogin.clientID)}`,
      `client_secret=${urlFormEncoded(AntigravityLogin.clientSecret)}`,
      `refresh_token=${urlFormEncoded(refreshToken)}`,
      'grant_type=refresh_token'
    ].join('&')
    const request = HTTPRequest.make('POST', AntigravityLogin.tokenURL, { 'Content-Type': 'application/x-www-form-urlencoded' }, form, 15)
    const token = OAuthTokenResponse.renewal(await http.send(request), 'antigravity')
    return OAuthGrant.make(token.accessToken, undefined, addSeconds(now, token.expiresIn ?? 3600))
  }
}

interface ClaudeProfileResponse {
  account: { email?: string; uuid: string }
  organization?: { uuid?: string }
  email?: string
}

function decodeClaudeProfileResponse(json: JSONObject): ClaudeProfileResponse {
  const account = Decode.nested(json, 'account')
  const organization = Decode.optionalNested(json, 'organization')
  const response: ClaudeProfileResponse = { account: { uuid: Decode.string(account, 'uuid') } }
  const accountEmail = Decode.optionalString(account, 'email')
  if (accountEmail !== undefined) response.account.email = accountEmail
  if (organization) {
    response.organization = {}
    const uuid = Decode.optionalString(organization, 'uuid')
    if (uuid !== undefined) response.organization.uuid = uuid
  }
  const email = Decode.optionalString(json, 'email')
  if (email !== undefined) response.email = email
  return response
}

interface GoogleUserInfo {
  id?: string
  email?: string
}

function decodeGoogleUserInfo(json: JSONObject): GoogleUserInfo {
  const user: GoogleUserInfo = {}
  const id = Decode.optionalString(json, 'id')
  const email = Decode.optionalString(json, 'email')
  if (id !== undefined) user.id = id
  if (email !== undefined) user.email = email
  return user
}

interface CodexDeviceStart {
  deviceAuthID: string
  userCode: string
}

function decodeCodexDeviceStart(json: JSONObject): CodexDeviceStart {
  return { deviceAuthID: Decode.string(json, 'device_auth_id'), userCode: Decode.string(json, 'user_code') }
}

interface CodexDeviceToken {
  authorizationCode: string
  codeVerifier: string
}

function decodeCodexDeviceToken(json: JSONObject): CodexDeviceToken {
  return { authorizationCode: Decode.string(json, 'authorization_code'), codeVerifier: Decode.string(json, 'code_verifier') }
}
