import { RefreshSetting } from '../stores/RefreshSetting'
import { bodyText, utf8 } from '../support/ProviderParse'
import { secondsBetween, type Instant, type Seconds } from '../support/time'

export interface HTTPRequest {
  method: string
  url: string
  headers?: Record<string, string>
  body?: Uint8Array
  /** Seconds. Defaults to 15. */
  timeout?: Seconds
}

export const HTTPRequest = {
  defaultTimeout: 15 as Seconds,

  make(method: string, url: string, headers: Record<string, string> = {}, body?: Uint8Array | string, timeout?: Seconds): HTTPRequest {
    const request: HTTPRequest = { method, url, headers }
    if (body !== undefined) request.body = typeof body === 'string' ? utf8(body) : body
    if (timeout !== undefined) request.timeout = timeout
    return request
  }
}

/** Parses an HTTP date (`Sun, 06 Nov 1994 08:49:37 GMT`). */
function httpDate(value: string): Instant | undefined {
  const match = /^[A-Za-z]{3}, (\d{2}) ([A-Za-z]{3}) (\d{4}) (\d{2}):(\d{2}):(\d{2}) (GMT|UTC|UT)$/.exec(value.trim())
  if (!match) return undefined
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(match[2])
  if (month < 0) return undefined
  const instant = Date.UTC(Number(match[3]), month, Number(match[1]), Number(match[4]), Number(match[5]), Number(match[6]))
  return Number.isFinite(instant) ? instant : undefined
}

export class HTTPResponse {
  statusCode: number
  /** Keyed by lowercased header name. */
  headers: Record<string, string>
  body: Uint8Array

  constructor(statusCode: number, headers: Record<string, string> = {}, body: Uint8Array | string = new Uint8Array()) {
    this.statusCode = statusCode
    this.headers = {}
    for (const [name, value] of Object.entries(headers)) this.headers[name.toLowerCase()] = value
    this.body = typeof body === 'string' ? utf8(body) : body
  }

  header(name: string): string | undefined {
    return this.headers[name.toLowerCase()]
  }

  /** The body as UTF-8 text. */
  get text(): string {
    return bodyText(this.body)
  }

  get isSuccess(): boolean {
    return this.statusCode >= 200 && this.statusCode < 300
  }

  /** The response's `Date` header. */
  get date(): Instant | undefined {
    const value = this.header('Date')
    return value === undefined ? undefined : httpDate(value)
  }

  /** How long the server asked to wait, capped at the longest backoff; undefined when it didn't say. */
  retryAfter(now: Instant = Date.now()): Seconds | undefined {
    const value = this.header('Retry-After')?.trim()
    if (value === undefined) return undefined
    let seconds: number | undefined
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) seconds = Number(value)
    else {
      const date = httpDate(value)
      seconds = date === undefined ? undefined : secondsBetween(date, now)
    }
    if (seconds === undefined || !Number.isFinite(seconds) || !(seconds > 0)) return undefined
    return Math.min(seconds, RefreshSetting.failureBackoffCap)
  }
}

/**
 * Sends one request and returns whatever the server answered, whatever its status. It throws only
 * when no answer came back: a `NetworkError` (see `models/ProviderSnapshot`) for a transport failure.
 * The desktop app's client applies the user's proxy; tests pass a stub.
 */
export interface HTTPClient {
  send(request: HTTPRequest): Promise<HTTPResponse>
}

export class HTTPClientError extends Error {
  constructor() {
    super('Invalid HTTP response.')
    this.name = 'HTTPClientError'
  }
}

/** `GET host/path -> 200 (123 ms)`: never the query, a header, or a body. */
export function httpDiagnostic(request: HTTPRequest, response: HTTPResponse, durationMs: number): string {
  let endpoint = request.url
  try {
    const url = new URL(request.url)
    endpoint = url.hostname + url.pathname
  } catch {
    endpoint = request.url.split('?')[0]
  }
  return `${request.method} ${endpoint} -> ${response.statusCode} (${Math.round(durationMs)} ms)`
}
