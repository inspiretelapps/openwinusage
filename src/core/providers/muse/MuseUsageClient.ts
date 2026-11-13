import { HTTPRequest, type HTTPClient } from '../../services/HTTPClient'
import { isJSONObject, ProviderParse, type JSONObject } from '../../support/ProviderParse'
import { fromUnixSeconds, type Instant } from '../../support/time'
import { ProviderError } from '../ProviderError'

/** The fields the app reads from Muse Code's key response, and nothing else. */
export interface MuseAccount {
  isSubscribed: boolean
  plan?: string
  email?: string
  usage?: MuseAccountUsage
}

export interface MuseAccountUsage {
  window?: MuseAccountWindow
  weekly?: MuseAccountWindow
}

export interface MuseAccountWindow {
  usedPercent: number
  resetsAt?: Instant
}

/** Thrown inside the decode for a field of the wrong type; `account` reports it as an invalid response. */
class DecodingError extends Error {}

/** An optional field: absent or null is none, and any other type is a decoding failure. */
function optional<T>(value: unknown, decode: (value: unknown) => T): T | undefined {
  return value === undefined || value === null ? undefined : decode(value)
}

function string(value: unknown): string {
  if (typeof value !== 'string') throw new DecodingError()
  return value
}

function number(value: unknown): number {
  if (typeof value !== 'number') throw new DecodingError()
  return value
}

function object(value: unknown): JSONObject {
  if (!isJSONObject(value)) throw new DecodingError()
  return value
}

function decodeWindow(value: unknown): MuseAccountWindow {
  const fields = object(value)
  const window: MuseAccountWindow = { usedPercent: number(fields.used_percent) }
  const resetsAt = optional(fields.resets_at, number)
  if (resetsAt !== undefined) window.resetsAt = fromUnixSeconds(resetsAt)
  return window
}

function decodeUsage(value: unknown): MuseAccountUsage {
  const fields = object(value)
  const usage: MuseAccountUsage = {}
  const window = optional(fields.window, decodeWindow)
  if (window !== undefined) usage.window = window
  const weekly = optional(fields.weekly, decodeWindow)
  if (weekly !== undefined) usage.weekly = weekly
  return usage
}

/** Copies only the fields named in `MuseAccount`; the response's Model API key is never read. */
function decodeAccount(value: unknown): MuseAccount {
  const fields = object(value)
  if (typeof fields.is_subs_active !== 'boolean') throw new DecodingError()
  const account: MuseAccount = { isSubscribed: fields.is_subs_active }
  const plan = optional(fields.subs_tier_name, string)
  if (plan !== undefined) account.plan = plan
  const email = optional(fields.user_email, string)
  if (email !== undefined) account.email = email
  const usage = optional(fields.subs_usage, decodeUsage)
  if (usage !== undefined) account.usage = usage
  return account
}

/**
 * Reads a Muse Code subscription through the request the Muse CLI makes at startup. Its answer also
 * carries the account's Model API key, so the body is decoded only into `MuseAccount`, which has no
 * field for the key, and goes nowhere else.
 */
export class MuseUsageClient {
  static readonly keyURL = 'https://api.meta.ai/muse-code/key'

  readonly http: HTTPClient

  constructor(http: HTTPClient) {
    this.http = http
  }

  async account(token: string): Promise<MuseAccount> {
    const response = await this.http.send(
      HTTPRequest.make(
        'POST',
        MuseUsageClient.keyURL,
        {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'x-api-version': '1.0.0'
        },
        '{"onboard":false}'
      )
    )
    ProviderError.requireSuccess(response, 'muse')
    try {
      return decodeAccount(ProviderParse.json(response.body))
    } catch {
      throw ProviderError.invalidResponse
    }
  }
}
