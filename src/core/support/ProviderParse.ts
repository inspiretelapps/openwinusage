import { AppLog, describeError } from './AppLog'
import { fromUnixSeconds, type Instant } from './time'
import { rounded } from './numbers'

export type JSONObject = Record<string, unknown>

const decoder = new TextDecoder('utf-8')
const encoder = new TextEncoder()

/** `String(data:encoding: .utf8)` */
export function bodyText(body: Uint8Array | string): string {
  return typeof body === 'string' ? body : decoder.decode(body)
}

/** `Data(string.utf8)` */
export function utf8(text: string): Uint8Array {
  return encoder.encode(text)
}

/** Whether a decoded JSON value is an object (a Swift `[String: Any]`), not an array or null. */
export function isJSONObject(value: unknown): value is JSONObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** `value as? [String: Any]` */
export function asObject(value: unknown): JSONObject | undefined {
  return isJSONObject(value) ? value : undefined
}

/** `value as? [Any]` */
export function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined
}

/** `value as? String` */
export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

const numericText = /^[+-]?(?:\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)$/

export const ProviderParse = {
  jsonObject(data: Uint8Array | string): JSONObject | undefined {
    const text = bodyText(data)
    if (text.length === 0) return undefined
    try {
      return asObject(JSON.parse(text))
    } catch (error) {
      AppLog.warn('http', `response body is not valid JSON (${data.length} bytes): ${describeError(error)}`)
      return undefined
    }
  },

  /** Any decoded JSON value (an array, for example), or undefined when the body isn't JSON. */
  json(data: Uint8Array | string): unknown {
    const text = bodyText(data)
    if (text.length === 0) return undefined
    try {
      return JSON.parse(text)
    } catch {
      return undefined
    }
  },

  /** Permissive numeric read: accepts JSON numbers and numeric strings, rejecting booleans and non-finite values. */
  number(value: unknown): number | undefined {
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (!numericText.test(trimmed)) return undefined
      const parsed = Number(trimmed)
      return Number.isFinite(parsed) ? parsed : undefined
    }
    return undefined
  },

  /** `Int(_:)` traps on a value outside the Int range; this returns undefined instead. Truncates toward zero. */
  int(value: number): number | undefined {
    return Math.abs(value) < 9.223372036854776e18 ? Math.trunc(value) : undefined
  },

  bool(value: unknown): boolean | undefined {
    if (typeof value === 'boolean') return value
    if (typeof value === 'number') return value !== 0
    if (typeof value === 'string') {
      switch (value.trim().toLowerCase()) {
        case 'true':
        case '1':
          return true
        case 'false':
        case '0':
          return false
        default:
          return undefined
      }
    }
    return undefined
  },

  clampPercent(value: number): number {
    if (!Number.isFinite(value)) return 0
    return Math.min(Math.max(value, 0), 100)
  },

  centsToDollars(cents: number): number {
    return rounded(cents) / 100
  },

  jwtPayload(token: string): JSONObject | undefined {
    const data = ProviderParse.jwtPayloadText(token)
    if (data === undefined) return undefined
    try {
      return asObject(JSON.parse(data))
    } catch {
      return undefined
    }
  },

  /** The token's payload segment, decoded from base64url to text. */
  jwtPayloadText(token: string): string | undefined {
    const parts = token.split('.').filter((part) => part.length > 0)
    if (parts.length < 2) return undefined
    let payload = parts[1].replaceAll('-', '+').replaceAll('_', '/')
    while (payload.length % 4 !== 0) payload += '='
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) return undefined
    try {
      const binary = atob(payload)
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
      return decoder.decode(bytes)
    } catch {
      return undefined
    }
  },

  jwtExpiry(token: string): Instant | undefined {
    const exp = ProviderParse.number(ProviderParse.jwtPayload(token)?.exp)
    return exp === undefined ? undefined : fromUnixSeconds(exp)
  }
}

const unreserved = /[A-Za-z0-9\-._~]/

/**
 * Percent-encode one `application/x-www-form-urlencoded` value. Only the ASCII characters RFC 3986
 * defines as unreserved pass through; spaces use `%20` so a literal `+` remains distinguishable from a
 * form-space separator.
 */
export function urlFormEncoded(text: string): string {
  let out = ''
  for (const byte of encoder.encode(text)) {
    const char = String.fromCharCode(byte)
    out += byte < 0x80 && unreserved.test(char) ? char : '%' + byte.toString(16).toUpperCase().padStart(2, '0')
  }
  return out
}

export function nilIfEmpty(text: string | undefined | null): string | undefined {
  return text === undefined || text === null || text.length === 0 ? undefined : text
}

/** `String.titleCased(separator:lowercasingTail:)` */
export function titleCased(text: string, isSeparator: (char: string) => boolean, lowercasingTail = false): string {
  const words: string[] = []
  let current = ''
  for (const char of text) {
    if (isSeparator(char)) {
      if (current.length > 0) words.push(current)
      current = ''
    } else {
      current += char
    }
  }
  if (current.length > 0) words.push(current)
  return words
    .map((word) => {
      const chars = [...word]
      const head = (chars[0] ?? '').toUpperCase()
      const tail = chars.slice(1).join('')
      return head + (lowercasingTail ? tail.toLowerCase() : tail)
    })
    .join(' ')
}
