import { AccountCredential, newUUID, OAuthTokens } from '../../models/Account'
import type { HTTPClient } from '../../services/HTTPClient'
import { Decode, LoginError, LoginHTTP, cancellable, nextPastedCode } from '../../services/OAuthLoginSupport'
import { LoginPrompt, type ProviderLogin } from '../../services/ProviderLogin'
import type { JSONObject } from '../../support/ProviderParse'
import { ProviderError } from '../ProviderError'
import { DevinUsageClient } from './DevinUsageClient'

interface RegisterUserResponse {
  apiKey: string
  apiServerURL?: string
}

interface UserStatus {
  email?: string
  teamId?: string
}

/** Devin accounts sign in through the token page that Windsurf's editor plugins use. */
export class DevinLogin implements ProviderLogin {
  static readonly tokenPageURL = 'https://windsurf.com/profile'
  static readonly registerURL = 'https://api.codeium.com/register_user/'
  readonly http: HTTPClient

  constructor(http: HTTPClient) {
    this.http = http
  }

  async login(
    prompt: (prompt: LoginPrompt) => Promise<void> | void,
    pastedCode: AsyncIterable<string>,
    signal?: AbortSignal
  ): Promise<{ label: string; credential: AccountCredential }> {
    // Swift's `UUID().uuidString` is uppercase, and the state goes to Windsurf as it is.
    await cancellable(signal, prompt(LoginPrompt.browserToken(DevinLogin.tokenPage(newUUID().toUpperCase()))))
    const value = await nextPastedCode(pastedCode, signal)
    if (value === undefined) throw LoginError.cancelled
    const pasted = value.trim()
    if (pasted.length === 0) throw LoginError.invalidCode
    const tokens = (await this.registeredKey(pasted, signal)) ?? OAuthTokens.make(pasted)
    const status = await cancellable(signal, new DevinUsageClient(this.http).fetchUserStatus(tokens))
    if (ProviderError.isAuthFailure(status)) {
      throw LoginError.failed('Windsurf rejected that token. A token works for 5 minutes, so click Try Again to get a new one.')
    }
    const user = LoginHTTP.decode(DevinLogin.userStatus, status)
    if (user.email !== undefined) {
      tokens.extras[OAuthTokens.identityKey] = user.teamId !== undefined ? `devin:${user.email}/${user.teamId}` : `devin:${user.email}`
    }
    return { label: user.email ?? 'Devin Account', credential: AccountCredential.oauth(tokens) }
  }

  private static tokenPage(state: string): string {
    const query: [string, string][] = [
      ['response_type', 'token'],
      ['redirect_uri', 'show-auth-token'],
      ['state', state],
      ['scope', 'openid profile email'],
      ['redirect_parameters_type', 'query']
    ]
    return `${DevinLogin.tokenPageURL}?${query.map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('&')}`
  }

  /**
   * RegisterUser refuses anything but a token from the page, so after a refusal the pasted value is
   * tried as an API key.
   */
  private async registeredKey(token: string, signal: AbortSignal | undefined): Promise<OAuthTokens | undefined> {
    const response = await cancellable(signal, LoginHTTP.postJSON(DevinLogin.registerURL, { firebase_id_token: token }, this.http))
    if (ProviderError.isAuthFailure(response)) return undefined
    const registered = LoginHTTP.decode(DevinLogin.registerUserResponse, response)
    if (registered.apiKey.length === 0) throw LoginError.invalidResponse
    const tokens = OAuthTokens.make(registered.apiKey)
    const server = registered.apiServerURL
    if (server !== undefined && server.length > 0) {
      if (!DevinLogin.isHTTPSURL(server)) throw LoginError.invalidResponse
      tokens.extras[DevinUsageClient.apiServerURLKey] = server
    }
    return tokens
  }

  private static isHTTPSURL(text: string): boolean {
    try {
      const url = new URL(text)
      return url.protocol === 'https:' && url.hostname.length > 0
    } catch {
      return false
    }
  }

  /** `RegisterUserResponse`: `api_key`, and `api_server_url` when Windsurf names a server. */
  private static registerUserResponse(json: JSONObject): RegisterUserResponse {
    const registered: RegisterUserResponse = { apiKey: Decode.string(json, 'api_key') }
    const server = Decode.optionalString(json, 'api_server_url')
    if (server !== undefined) registered.apiServerURL = server
    return registered
  }

  /** `UserStatusResponse.userStatus`: the fields that name the account. */
  private static userStatus(json: JSONObject): UserStatus {
    const fields = Decode.nested(json, 'userStatus')
    const user: UserStatus = {}
    const email = Decode.optionalString(fields, 'email')
    if (email !== undefined) user.email = email
    const teamId = Decode.optionalString(fields, 'teamId')
    if (teamId !== undefined) user.teamId = teamId
    return user
  }
}
