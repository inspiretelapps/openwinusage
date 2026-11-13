import { ProviderKind } from '../models/Account'
import { RefreshFailure } from '../models/ProviderSnapshot'
import type { HTTPResponse } from '../services/HTTPClient'
import { AppInfo } from '../support/AppInfo'
import { ProviderParse, type JSONObject } from '../support/ProviderParse'
import type { Instant, Seconds } from '../support/time'

export type ProviderErrorCase =
  | { type: 'signInExpired'; kind: ProviderKind }
  | { type: 'connectionFailed' }
  | { type: 'invalidResponse' }
  | { type: 'requestFailed'; status: number }
  | { type: 'rateLimited'; retryAfter?: Seconds }
  | { type: 'unavailable'; message: string }
  | { type: 'keyRejected'; message: string }
  /** A server between the app and the provider, such as a CLIProxyAPI hub, can't be reached. */
  | { type: 'unreachable'; message: string }

function describe(error: ProviderErrorCase): string {
  switch (error.type) {
    case 'signInExpired':
      return `${ProviderKind.displayName(error.kind)} sign-in expired. Sign in again to keep reading usage.`
    case 'connectionFailed':
      return 'Connection failed. Check your internet connection and try again.'
    case 'invalidResponse':
      return 'The provider returned an invalid response.'
    case 'requestFailed':
      return `The provider request failed (HTTP ${error.status}).`
    case 'rateLimited':
      return `The provider asked ${AppInfo.name} to wait before asking again.`
    case 'unavailable':
      return error.message
    case 'keyRejected':
      return `${error.message} Replace it on the account's page.`
    case 'unreachable':
      return error.message
  }
}

/** GitHub sends its rate limits as 403 with `x-ratelimit-remaining: 0` or `retry-after`. */
function isRateLimit(response: HTTPResponse): boolean {
  return (
    response.statusCode === 429 ||
    (response.statusCode === 403 && (response.header('x-ratelimit-remaining') === '0' || response.header('retry-after') !== undefined))
  )
}

/**
 * Everything a provider read can fail with. Swift's enum cases are `error.case.type`; build one with
 * the static factories and test for one with `ProviderError.is(error, 'rateLimited')`.
 */
export class ProviderError extends Error {
  readonly case: ProviderErrorCase

  constructor(errorCase: ProviderErrorCase) {
    super(describe(errorCase))
    this.name = 'ProviderError'
    this.case = errorCase
  }

  static signInExpired(kind: ProviderKind): ProviderError {
    return new ProviderError({ type: 'signInExpired', kind })
  }
  static get connectionFailed(): ProviderError {
    return new ProviderError({ type: 'connectionFailed' })
  }
  static get invalidResponse(): ProviderError {
    return new ProviderError({ type: 'invalidResponse' })
  }
  static requestFailed(status: number): ProviderError {
    return new ProviderError({ type: 'requestFailed', status })
  }
  static rateLimited(retryAfter?: Seconds): ProviderError {
    return new ProviderError(retryAfter === undefined ? { type: 'rateLimited' } : { type: 'rateLimited', retryAfter })
  }
  static unavailable(message: string): ProviderError {
    return new ProviderError({ type: 'unavailable', message })
  }
  static keyRejected(message: string): ProviderError {
    return new ProviderError({ type: 'keyRejected', message })
  }
  static unreachable(message: string): ProviderError {
    return new ProviderError({ type: 'unreachable', message })
  }

  /** Whether `error` is a `ProviderError`, optionally of one case: Swift's `catch ProviderError.signInExpired`. */
  static is<T extends ProviderErrorCase['type']>(
    error: unknown,
    type?: T
  ): error is ProviderError & { case: Extract<ProviderErrorCase, { type: T }> } {
    return error instanceof ProviderError && (type === undefined || error.case.type === type)
  }

  equals(other: unknown): boolean {
    return other instanceof ProviderError && JSON.stringify(this.case) === JSON.stringify(other.case)
  }

  static isAuthFailure(response: HTTPResponse): boolean {
    return response.statusCode === 401 || (response.statusCode === 403 && !isRateLimit(response))
  }

  static isRateLimit(response: HTTPResponse): boolean {
    return isRateLimit(response)
  }

  /** Throws for anything but a 2xx: the expired sign-in for 401/403, else `failed(response)`. */
  static requireSuccess(response: HTTPResponse, kind: ProviderKind): void {
    if (ProviderError.isAuthFailure(response)) throw ProviderError.signInExpired(kind)
    if (!(response.statusCode >= 200 && response.statusCode < 300)) throw ProviderError.failed(response)
  }

  static requireSuccessJSON(response: HTTPResponse, kind: ProviderKind): JSONObject {
    ProviderError.requireSuccess(response, kind)
    const body = ProviderParse.jsonObject(response.body)
    if (!body) throw ProviderError.invalidResponse
    return body
  }

  static failed(response: HTTPResponse, now: Instant = Date.now()): ProviderError {
    return isRateLimit(response) ? ProviderError.rateLimited(response.retryAfter(now)) : ProviderError.requestFailed(response.statusCode)
  }
}

RefreshFailure.registerClassifier((error) => {
  if (!(error instanceof ProviderError)) return undefined
  switch (error.case.type) {
    case 'rateLimited':
      return error.case.retryAfter === undefined ? { type: 'rateLimited' } : { type: 'rateLimited', retryAfter: error.case.retryAfter }
    case 'connectionFailed':
    case 'unreachable':
      return { type: 'unreachable' }
    default:
      return { type: 'refused' }
  }
})
