import { OAuthTokens, type ProviderKind } from '../models/Account'
import { ProviderError } from '../providers/ProviderError'
import { AppLog } from '../support/AppLog'
import { ProviderParse, asObject, asString, bodyText, isJSONObject, urlFormEncoded, type JSONObject } from '../support/ProviderParse'
import { addSeconds, type Instant } from '../support/time'
import { HTTPRequest, type HTTPClient, type HTTPResponse } from './HTTPClient'
import type { LoopbackCallbackServer } from './LoopbackCallbackServer'
import type { PKCEPair } from './PKCE'
import type { LoginPrompt } from './ProviderLogin'

export const LoginHTTP = {
  async postForm(url: string, fields: Record<string, string>, client: HTTPClient, headers: Record<string, string> = {}): Promise<HTTPResponse> {
    const requestHeaders: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      ...headers
    }
    const body = Object.entries(fields)
      .map(([key, value]) => `${key}=${urlFormEncoded(value)}`)
      .sort()
      .join('&')
    return client.send(HTTPRequest.make('POST', url, requestHeaders, body))
  },

  async postJSON(url: string, fields: Record<string, string>, client: HTTPClient): Promise<HTTPResponse> {
    return client.send(HTTPRequest.make('POST', url, { 'Content-Type': 'application/json' }, JSON.stringify(fields)))
  },

  async get(url: string, bearerToken: string | undefined, client: HTTPClient, headers: Record<string, string> = {}): Promise<HTTPResponse> {
    const requestHeaders: Record<string, string> = { ...headers }
    if (bearerToken !== undefined) requestHeaders.Authorization = `Bearer ${bearerToken}`
    return client.send(HTTPRequest.make('GET', url, requestHeaders))
  },

  /**
   * `LoginHTTP.decode(Type.self, from: response)`: `type` reads the body's JSON object into the type and
   * throws a `DecodingError` for a body that doesn't fit, the way a `Decodable` type does. Without a
   * `type`, the body's JSON object comes back as it is.
   */
  decode
}

function decode(response: HTTPResponse): JSONObject
function decode<T>(type: (json: JSONObject) => T, response: HTTPResponse): T
function decode<T>(first: HTTPResponse | ((json: JSONObject) => T), second?: HTTPResponse): T | JSONObject {
  const response = typeof first === 'function' ? second! : first
  if (!(response.statusCode >= 200 && response.statusCode < 300)) throw LoginError.requestFailed(response.statusCode)
  const json = Decode.object(response.body)
  return typeof first === 'function' ? first(json) : json
}

/**
 * What `JSONDecoder` throws for a body that doesn't fit the type, with the two descriptions Foundation
 * gives it: a required value that is absent or null, and anything else that can't be read.
 */
export class DecodingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DecodingError'
  }

  static get missing(): DecodingError {
    return new DecodingError('The data couldn’t be read because it is missing.')
  }

  static get wrongFormat(): DecodingError {
    return new DecodingError('The data couldn’t be read because it isn’t in the correct format.')
  }
}

function present(value: unknown): boolean {
  return value !== undefined && value !== null
}

/** Reads fields the way a `Decodable` type's synthesized decoder does: a required field has to be there, and every field has to have its type. */
export const Decode = {
  /** The body as a JSON object; anything else is not in the correct format. */
  object(body: Uint8Array | string): JSONObject {
    let json: unknown
    try {
      json = JSON.parse(bodyText(body))
    } catch {
      throw DecodingError.wrongFormat
    }
    if (!isJSONObject(json)) throw DecodingError.wrongFormat
    return json
  },

  string(json: JSONObject, key: string): string {
    const value = Decode.optionalString(json, key)
    if (value === undefined) throw DecodingError.missing
    return value
  },

  optionalString(json: JSONObject, key: string): string | undefined {
    const value = json[key]
    if (!present(value)) return undefined
    if (typeof value !== 'string') throw DecodingError.wrongFormat
    return value
  },

  /** A `Double`. */
  number(json: JSONObject, key: string): number {
    const value = Decode.optionalNumber(json, key)
    if (value === undefined) throw DecodingError.missing
    return value
  },

  optionalNumber(json: JSONObject, key: string): number | undefined {
    const value = json[key]
    if (!present(value)) return undefined
    if (typeof value !== 'number') throw DecodingError.wrongFormat
    return value
  },

  /** An `Int`: a JSON number with a fraction doesn't fit. */
  int(json: JSONObject, key: string): number {
    const value = Decode.optionalInt(json, key)
    if (value === undefined) throw DecodingError.missing
    return value
  },

  optionalInt(json: JSONObject, key: string): number | undefined {
    const value = Decode.optionalNumber(json, key)
    if (value !== undefined && !Number.isSafeInteger(value)) throw DecodingError.wrongFormat
    return value
  },

  /** A nested type. */
  nested(json: JSONObject, key: string): JSONObject {
    const value = Decode.optionalNested(json, key)
    if (value === undefined) throw DecodingError.missing
    return value
  },

  optionalNested(json: JSONObject, key: string): JSONObject | undefined {
    const value = json[key]
    if (!present(value)) return undefined
    if (!isJSONObject(value)) throw DecodingError.wrongFormat
    return value
  }
}

export interface OAuthTokenResponse {
  accessToken: string
  refreshToken?: string
  expiresIn?: number
  idToken?: string
}

const refusedRenewalCodes = ['invalid_grant', 'refresh_token_expired', 'refresh_token_reused', 'refresh_token_invalidated']

/** RFC 6749 sends `error` as a string; OpenAI also sends `error.code` or a top-level `code`. */
function errorCode(body: Uint8Array): string | undefined {
  const json = ProviderParse.jsonObject(body)
  const error = json?.error
  return asString(error) ?? asString(asObject(error)?.code) ?? asString(json?.code)
}

export const OAuthTokenResponse = {
  /** The `Decodable` conformance: pass it to `LoginHTTP.decode`. */
  decode(json: JSONObject): OAuthTokenResponse {
    const token: OAuthTokenResponse = { accessToken: Decode.string(json, 'access_token') }
    const refreshToken = Decode.optionalString(json, 'refresh_token')
    const expiresIn = Decode.optionalNumber(json, 'expires_in')
    const idToken = Decode.optionalString(json, 'id_token')
    if (refreshToken !== undefined) token.refreshToken = refreshToken
    if (expiresIn !== undefined) token.expiresIn = expiresIn
    if (idToken !== undefined) token.idToken = idToken
    return token
  },

  /** `try? JSONDecoder().decode(OAuthTokenResponse.self, from: body)` */
  decodeBody(body: Uint8Array | string): OAuthTokenResponse | undefined {
    try {
      return OAuthTokenResponse.decode(Decode.object(body))
    } catch {
      return undefined
    }
  },

  expiry(token: OAuthTokenResponse): Instant | undefined {
    return token.expiresIn === undefined ? undefined : addSeconds(Date.now(), token.expiresIn)
  },

  grant(token: OAuthTokenResponse, now: Instant): OAuthGrant {
    return OAuthGrant.make(token.accessToken, token.refreshToken, token.expiresIn === undefined ? undefined : addSeconds(now, token.expiresIn))
  },

  tokens(token: OAuthTokenResponse, extras: Record<string, string>): OAuthTokens {
    return OAuthTokens.make(token.accessToken, token.refreshToken, OAuthTokenResponse.expiry(token), extras)
  },

  /**
   * `OAuthTokenResponse(renewal:kind:)`. Only a refusal of the refresh token itself is an expired
   * sign-in; an outage, a rate limit, or a malformed answer fails this refresh like any provider
   * request, so the next pass renews again.
   */
  renewal(response: HTTPResponse, kind: ProviderKind): OAuthTokenResponse {
    if ([400, 401, 403].includes(response.statusCode)) {
      const code = errorCode(response.body)
      if (code !== undefined && refusedRenewalCodes.includes(code)) {
        AppLog.warn('auth', `${kind} sign-in renewal refused: ${code}`)
        throw ProviderError.signInExpired(kind)
      }
    }
    if (!(response.statusCode >= 200 && response.statusCode < 300)) throw ProviderError.failed(response)
    const token = OAuthTokenResponse.decodeBody(response.body)
    if (!token || token.accessToken.length === 0) throw ProviderError.invalidResponse
    return token
  }
}

export interface OAuthGrant {
  accessToken: string
  refreshToken?: string
  expiresAt?: Instant
}

export const OAuthGrant = {
  make(accessToken: string, refreshToken?: string, expiresAt?: Instant): OAuthGrant {
    const grant: OAuthGrant = { accessToken }
    if (refreshToken !== undefined) grant.refreshToken = refreshToken
    if (expiresAt !== undefined) grant.expiresAt = expiresAt
    return grant
  }
}

export type LoginErrorCase =
  | { type: 'cancelled' }
  | { type: 'invalidResponse' }
  | { type: 'requestFailed'; status: number }
  | { type: 'invalidState' }
  | { type: 'invalidCode' }
  | { type: 'listenerFailed'; detail: string }
  | { type: 'invalidCallback' }
  | { type: 'authorizationFailed'; error: string }
  | { type: 'failed'; message: string }

function describe(error: LoginErrorCase): string {
  switch (error.type) {
    case 'cancelled':
      return 'Sign-in was cancelled.'
    case 'invalidResponse':
      return 'The sign-in service returned an invalid response.'
    case 'requestFailed':
      return `Sign-in failed with HTTP ${error.status}.`
    case 'invalidState':
      return 'The sign-in response did not match this request.'
    case 'invalidCode':
      return 'The authorization code was invalid.'
    case 'listenerFailed':
      return `Could not start the sign-in callback: ${error.detail}`
    case 'invalidCallback':
      return 'The sign-in callback request was invalid.'
    case 'authorizationFailed':
      return `Authorization failed: ${error.error}`
    case 'failed':
      return error.message
  }
}

/** Everything a sign-in can fail with. Swift's enum cases are `error.case.type`; test for one with `LoginError.is(error, 'cancelled')`. */
export class LoginError extends Error {
  readonly case: LoginErrorCase

  constructor(errorCase: LoginErrorCase) {
    super(describe(errorCase))
    this.name = 'LoginError'
    this.case = errorCase
  }

  static get cancelled(): LoginError {
    return new LoginError({ type: 'cancelled' })
  }
  static get invalidResponse(): LoginError {
    return new LoginError({ type: 'invalidResponse' })
  }
  static requestFailed(status: number): LoginError {
    return new LoginError({ type: 'requestFailed', status })
  }
  static get invalidState(): LoginError {
    return new LoginError({ type: 'invalidState' })
  }
  static get invalidCode(): LoginError {
    return new LoginError({ type: 'invalidCode' })
  }
  static listenerFailed(detail: string): LoginError {
    return new LoginError({ type: 'listenerFailed', detail })
  }
  static get invalidCallback(): LoginError {
    return new LoginError({ type: 'invalidCallback' })
  }
  static authorizationFailed(error: string): LoginError {
    return new LoginError({ type: 'authorizationFailed', error })
  }
  static failed(message: string): LoginError {
    return new LoginError({ type: 'failed', message })
  }

  /** Whether `error` is a `LoginError`, optionally of one case. */
  static is<T extends LoginErrorCase['type']>(error: unknown, type?: T): error is LoginError & { case: Extract<LoginErrorCase, { type: T }> } {
    return error instanceof LoginError && (type === undefined || error.case.type === type)
  }
}

// MARK: - Cancellation

/** `Task.checkCancellation()` for a login: throws `LoginError.cancelled` once the caller has cancelled. */
export function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw LoginError.cancelled
}

/**
 * Waits for `work`, or rejects with `LoginError.cancelled` as soon as the caller cancels. Swift cancels
 * the login's task, which ends whatever the login is waiting on; here every wait in a login goes through
 * this, so a cancelled login sends nothing more.
 */
export function cancellable<T>(signal: AbortSignal | undefined, work: Promise<T> | T): Promise<T> {
  const pending = Promise.resolve(work)
  if (!signal) return pending
  if (signal.aborted) {
    pending.catch(() => undefined)
    return Promise.reject(LoginError.cancelled)
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(LoginError.cancelled)
    signal.addEventListener('abort', onAbort, { once: true })
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

/**
 * The next code or token the user pastes: `await iterator.next()`. Undefined once the sheet stops
 * yielding, which the logins read as a cancelled sign-in.
 */
export async function nextPastedCode(pastedCode: AsyncIterable<string>, signal?: AbortSignal): Promise<string | undefined> {
  const iterator = pastedCode[Symbol.asyncIterator]()
  const next = await cancellable(signal, iterator.next())
  return next.done ? undefined : next.value
}

// MARK: - URLs

export interface URLQueryItem {
  name: string
  /** Undefined for an item without `=`. */
  value?: string
}

function percentDecoded(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

/** The parts of `URLComponents` the logins use. */
export const URLQuery = {
  /** `URLComponents.queryItems`: percent-decoded, and a `+` stays a `+`. */
  items(url: URL | string): URLQueryItem[] {
    let query: string
    if (typeof url === 'string') {
      const fragment = url.indexOf('#')
      const withoutFragment = fragment < 0 ? url : url.slice(0, fragment)
      const start = withoutFragment.indexOf('?')
      query = start < 0 ? '' : withoutFragment.slice(start + 1)
    } else {
      query = url.search.startsWith('?') ? url.search.slice(1) : url.search
    }
    if (query.length === 0) return []
    return query.split('&').map((part) => {
      const equals = part.indexOf('=')
      if (equals < 0) return { name: percentDecoded(part) }
      return { name: percentDecoded(part.slice(0, equals)), value: percentDecoded(part.slice(equals + 1)) }
    })
  },

  /** `queryItems.first { $0.name == name }?.value` */
  value(items: URLQueryItem[], name: string): string | undefined {
    return items.find((item) => item.name === name)?.value
  },

  /** `base` with its query replaced by `items`, each name and value percent-encoded. */
  url(base: string, items: [name: string, value: string][]): string {
    const query = items.map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`).join('&')
    const fragmentStart = base.indexOf('#')
    const fragment = fragmentStart < 0 ? '' : base.slice(fragmentStart)
    const withoutFragment = fragmentStart < 0 ? base : base.slice(0, fragmentStart)
    const queryStart = withoutFragment.indexOf('?')
    const path = queryStart < 0 ? withoutFragment : withoutFragment.slice(0, queryStart)
    return `${path}?${query}${fragment}`
  }
}

// MARK: - Browser authorization

export type AuthorizationInput = { type: 'callback'; code: string } | { type: 'pasted'; value: string }

export const AuthorizationInput = {
  callback(code: string): AuthorizationInput {
    return { type: 'callback', code }
  },

  pasted(value: string): AuthorizationInput {
    return { type: 'pasted', value }
  }
}

/**
 * Opens the provider's authorize page and waits for the code, from the loopback callback or from what
 * the user pastes, whichever comes first. The callback server is always stopped on the way out.
 */
export async function authorizeInBrowser(
  authorizeURL: string,
  clientID: string,
  scopes: string,
  state: string,
  pkce: PKCEPair,
  server: LoopbackCallbackServer,
  prompt: (prompt: LoginPrompt) => Promise<void> | void,
  pastedCode: AsyncIterable<string>,
  extraQuery: [name: string, value: string][] = [],
  signal?: AbortSignal
): Promise<string> {
  const onCancel = (): void => server.cancel()
  signal?.addEventListener('abort', onCancel, { once: true })
  try {
    throwIfCancelled(signal)
    const url = URLQuery.url(authorizeURL, [
      ['client_id', clientID],
      ['response_type', 'code'],
      ['redirect_uri', server.redirectURI],
      ['scope', scopes],
      ['code_challenge', pkce.challenge],
      ['code_challenge_method', 'S256'],
      ['state', state],
      ...extraQuery
    ])
    await cancellable(signal, prompt({ type: 'browser', url, acceptsPastedCode: true }))
    const iterator = pastedCode[Symbol.asyncIterator]()
    let input: AuthorizationInput
    try {
      input = await new Promise<AuthorizationInput>((resolve, reject) => {
        server.waitForCode().then((code) => resolve(AuthorizationInput.callback(code)), reject)
        iterator.next().then((next) => {
          if (!next.done) return resolve(AuthorizationInput.pasted(next.value))
          // The sheet stopped yielding. A callback that has already answered still decides the sign-in.
          if (!server.isFinished) reject(LoginError.cancelled)
        }, reject)
      })
    } finally {
      server.cancel()
      // `tasks.cancelAll()`: stop waiting on the sheet.
      try {
        void Promise.resolve(iterator.return?.()).catch(() => undefined)
      } catch {
        // An iterator that can't be ended has nothing more to release.
      }
    }
    return authorizationCode(input, state)
  } finally {
    signal?.removeEventListener('abort', onCancel)
    server.cancel()
  }
}

/** `split(separator:maxSplits:)`, which leaves out empty pieces. */
function split(text: string, separator: string, maxSplits: number): string[] {
  const pieces: string[] = []
  let start = 0
  let index = 0
  while (index < text.length) {
    if (text[index] === separator) {
      const didAppend = index > start
      if (didAppend) pieces.push(text.slice(start, index))
      start = index + 1
      if (didAppend && pieces.length === maxSplits) break
    }
    index += 1
  }
  if (start < text.length) pieces.push(text.slice(start))
  return pieces
}

function wholeURL(text: string): URL | undefined {
  try {
    const url = new URL(text)
    return url.hostname.length > 0 ? url : undefined
  } catch {
    return undefined
  }
}

export function authorizationCode(input: AuthorizationInput, expectedState: string): string {
  if (input.type === 'callback') return input.code
  const trimmed = input.value.trim()
  let code: string | undefined
  let state: string | undefined
  // Only a whole callback URL is read for its query: a bare code or a `code#state` pair has no
  // scheme and host, and so no query at all.
  const url = wholeURL(trimmed)
  if (url) {
    const items = URLQuery.items(url)
    code = URLQuery.value(items, 'code')
    state = URLQuery.value(items, 'state')
  } else if (trimmed.includes('#')) {
    const values = split(trimmed, '#', 1)
    code = values[0]
    state = values.length > 1 ? values[1] : undefined
  } else {
    code = trimmed
  }
  if (code === undefined || code.length === 0) throw LoginError.invalidCode
  if (state !== expectedState) throw LoginError.invalidState
  return code
}
