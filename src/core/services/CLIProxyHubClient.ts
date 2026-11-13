import { ProviderKind } from '../models/Account'
import { CLIProxyHub, HubLink, HubLogin, hubTokenPlaceholder } from '../models/CLIProxyHub'
import { ProviderError } from '../providers/ProviderError'
import { AppInfo } from '../support/AppInfo'
import { AppLog, LogTags, describeError } from '../support/AppLog'
import { ProviderParse, asString, bodyText, isJSONObject } from '../support/ProviderParse'
import type { Seconds } from '../support/time'
import { HTTPRequest, HTTPResponse, type HTTPClient } from './HTTPClient'
import type { HubKeyVault } from './HubKeyVault'

const logTag = LogTags.auth('cliproxy')

/**
 * The two management endpoints the app calls on a CLIProxyAPI hub: the login listing, and `api-call`,
 * which sends a request upstream with the hub's own token in place of `$TOKEN$`. Every call goes through
 * the hub's key gate. Neither the key nor a body is ever logged.
 */
export class CLIProxyHubClient {
  static readonly tokenPlaceholder = hubTokenPlaceholder

  readonly http: HTTPClient
  readonly gate: CLIProxyHubGate

  constructor(http: HTTPClient, gate: CLIProxyHubGate) {
    this.http = http
    this.gate = gate
  }

  async logins(hubID: string, url: string, key: string): Promise<HubLogin[]> {
    const response = await this.management('GET', 'auth-files', hubID, url, key)
    try {
      return HubLogin.listing(response.body)
    } catch {
      AppLog.error(logTag, `${CLIProxyHub.hostOf(url)} sent a login listing ${AppInfo.name} can't read`)
      throw ProviderError.unavailable(`The CLIProxyAPI hub at ${CLIProxyHub.hostOf(url)} sent a login list ${AppInfo.name} can't read.`)
    }
  }

  /**
   * The http address of an https hub that answers there instead, asked without the key: undefined when
   * nothing answers, or when the key couldn't go to that address over http anyway.
   */
  async plainHTTPAddress(url: string): Promise<string | undefined> {
    if (!url.startsWith('https://')) return undefined
    const plain = `http://${url.slice('https://'.length)}`
    if (!CLIProxyHub.allowsKey(plain)) return undefined
    try {
      const response = await this.http.send(HTTPRequest.make('GET', plain, {}, undefined, 5))
      return response.statusCode === 200 ? plain : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Sends `request` through the hub as the linked login and returns the upstream answer, so a
   * provider client reads it as if it had called the provider itself.
   */
  async call(request: HTTPRequest, link: HubLink, key: string, upstream: string): Promise<HTTPResponse> {
    const payload: Record<string, unknown> = {
      auth_index: link.authIndex,
      method: request.method,
      url: request.url,
      header: request.headers ?? {}
    }
    if (request.body !== undefined) payload.data = bodyText(request.body)
    const response = await this.management(
      'POST',
      'api-call',
      link.hubID,
      link.hubURL,
      key,
      JSON.stringify(payload),
      (request.timeout ?? HTTPRequest.defaultTimeout) + 10,
      upstream
    )
    const upstreamResponse = CLIProxyHubClient.unwrap(response.body)
    if (!upstreamResponse) {
      AppLog.error(logTag, `${HubLink.host(link)} sent an api-call answer ${AppInfo.name} can't read`)
      throw ProviderError.invalidResponse
    }
    return upstreamResponse
  }

  /** The upstream response inside an `api-call` envelope: `{status_code, header: {name: [value]}, body}`. */
  static unwrap(body: Uint8Array | string): HTTPResponse | undefined {
    let envelope: unknown
    try {
      envelope = JSON.parse(bodyText(body))
    } catch {
      return undefined
    }
    if (!isJSONObject(envelope)) return undefined
    const statusCode = envelope.status_code !== undefined ? envelope.status_code : envelope.statusCode
    if (typeof statusCode !== 'number' || !Number.isSafeInteger(statusCode)) return undefined
    const headers: Record<string, string> = {}
    const header = envelope.header
    if (header !== undefined && header !== null) {
      if (!isJSONObject(header)) return undefined
      for (const [name, values] of Object.entries(header)) {
        if (!Array.isArray(values) || !values.every((value): value is string => typeof value === 'string')) return undefined
        if (values.length > 0) headers[name.toLowerCase()] = values.join(', ')
      }
    }
    const text = envelope.body
    if (text !== undefined && text !== null && typeof text !== 'string') return undefined
    return new HTTPResponse(statusCode, headers, text ?? '')
  }

  private async management(
    method: string,
    path: string,
    hubID: string,
    url: string,
    key: string,
    body?: string,
    timeout: Seconds = 15,
    upstream?: string
  ): Promise<HTTPResponse> {
    const headers: Record<string, string> = { Authorization: `Bearer ${key}`, Accept: 'application/json' }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const request = HTTPRequest.make(method, `${url.replace(/\/+$/, '')}/v0/management/${path}`, headers, body, timeout)
    const host = CLIProxyHub.hostOf(url)
    if (!CLIProxyHub.allowsKey(url)) {
      AppLog.error(logTag, `${host} is plain http outside this computer, the local network, and Tailscale; not sending the management key`)
      throw ProviderError.unavailable(
        `Use https for ${host}. ${AppInfo.name} uses http only for a hub on this computer, your local network, or Tailscale.`
      )
    }
    let response: HTTPResponse
    try {
      response = await this.gate.send(hubID, host, key, () => this.http.send(request))
    } catch (error) {
      if (error instanceof ProviderError) throw error
      // A cancelled request stays a cancellation.
      if (error instanceof Error && error.name === 'AbortError') throw error
      AppLog.warn(logTag, `${host} ${path} unreachable: ${describeError(error)}`)
      throw ProviderError.unreachable(`Can’t reach the CLIProxyAPI hub at ${host}.`)
    }
    const refusal = HubRefusal.from(response)
    if (!refusal) return response
    AppLog.error(
      logTag,
      `${host} ${path} -> HTTP ${response.statusCode} (${HubRefusal.description(refusal)}), hub ${response.header('X-CPA-VERSION') ?? 'version unknown'}`
    )
    throw HubRefusal.error(refusal, host, upstream)
  }
}

/** A management answer that isn't a success, sorted by what the user can do about it. */
export type HubRefusal =
  | { type: 'keyRejected' }
  | { type: 'banned' }
  | { type: 'remoteManagementOff' }
  | { type: 'managementOff' }
  | { type: 'loginMissing' }
  | { type: 'noToken' }
  | { type: 'upstreamUnreachable' }
  | { type: 'failed'; status: number }

export const HubRefusal = {
  /** `HubRefusal(response)`: undefined for a success. */
  from(response: HTTPResponse): HubRefusal | undefined {
    const status = response.statusCode
    if (status >= 200 && status < 300) return undefined
    const message = (asString(ProviderParse.jsonObject(response.body)?.error) ?? '').toLowerCase()
    if (status === 401) return { type: 'keyRejected' }
    if (status === 403 && message.startsWith('ip banned')) return { type: 'banned' }
    if (status === 403 && message.includes('remote management disabled')) return { type: 'remoteManagementOff' }
    if (status === 404) return { type: 'managementOff' }
    if (status === 400 && message.includes('auth credential not found')) return { type: 'loginMissing' }
    if (status === 400 && message.includes('token')) return { type: 'noToken' }
    if (status === 502) return { type: 'upstreamUnreachable' }
    return { type: 'failed', status }
  },

  /** A refusal that a repeat would turn into another strike toward the hub's IP ban. */
  closesGate(refusal: HubRefusal): boolean {
    return refusal.type === 'keyRejected' || refusal.type === 'banned'
  },

  /** The refusal's name in a log line: `keyRejected`, `failed(500)`. */
  description(refusal: HubRefusal): string {
    return refusal.type === 'failed' ? `failed(${refusal.status})` : refusal.type
  },

  error(refusal: HubRefusal, host: string, upstream: string | undefined): ProviderError {
    switch (refusal.type) {
      case 'keyRejected':
        return ProviderError.unavailable(`The CLIProxyAPI hub at ${host} rejected the management key. Replace it in Accounts.`)
      case 'banned':
        return ProviderError.unavailable(
          `The CLIProxyAPI hub at ${host} blocked this computer after too many wrong keys. Wait 30 minutes, then replace the management key in Accounts.`
        )
      case 'remoteManagementOff':
        return ProviderError.unavailable(
          `The CLIProxyAPI hub at ${host} only allows management from its own machine. Turn on allow-remote in its config.`
        )
      case 'managementOff':
        return ProviderError.unavailable(
          `The CLIProxyAPI hub at ${host} has its management API turned off. Set a management key in its config.`
        )
      case 'loginMissing':
        return ProviderError.unavailable(`This login is no longer on the CLIProxyAPI hub at ${host}.`)
      case 'noToken':
        return ProviderError.unavailable(
          `The CLIProxyAPI hub at ${host} has no working sign-in for this login. Sign it in again on the hub.`
        )
      case 'upstreamUnreachable':
        return ProviderError.unreachable(`The CLIProxyAPI hub at ${host} couldn’t reach ${upstream ?? 'the provider'}.`)
      case 'failed':
        return ProviderError.unavailable(`The CLIProxyAPI hub at ${host} answered with an error (HTTP ${refusal.status}).`)
    }
  }
}

/**
 * Keeps a wrong management key to one strike per hub. CLIProxyAPI bans an IP for 30 minutes after five
 * wrong keys, and every mirrored account refreshes at once, so a hub's calls go one at a time: when the
 * hub rejects the key, or has banned this computer, the calls waiting behind fail without being sent, and
 * nothing more goes to that hub with that key. A refusal holds only the key it was sent with, so a late
 * answer to the replaced key never stops the new one.
 */
export class CLIProxyHubGate {
  private readonly busy = new Set<string>()
  private readonly waiters = new Map<string, (() => void)[]>()
  private readonly refused = new Map<string, { key: string; error: ProviderError }>()

  async send(hub: string, host: string, key: string, request: () => Promise<HTTPResponse>): Promise<HTTPResponse> {
    const held = this.refusal(hub, key)
    if (held) throw held
    if (this.busy.has(hub)) {
      await new Promise<void>((resume) => {
        const queue = this.waiters.get(hub) ?? []
        queue.push(resume)
        this.waiters.set(hub, queue)
      })
    } else {
      this.busy.add(hub)
    }
    try {
      const heldNow = this.refusal(hub, key)
      if (heldNow) throw heldNow
      const response = await request()
      const refusal = HubRefusal.from(response)
      if (refusal && HubRefusal.closesGate(refusal)) {
        const error = HubRefusal.error(refusal, host, undefined)
        this.refused.set(hub, { key, error })
        AppLog.error(logTag, `${host} ${HubRefusal.description(refusal)}; not calling it again until its key is replaced`)
        throw error
      }
      return response
    } finally {
      this.handOff(hub)
    }
  }

  /** Lets the hub be called again: its key was replaced, or the hub was removed. */
  reopen(hub: string): void {
    this.refused.delete(hub)
  }

  private refusal(hub: string, key: string): ProviderError | undefined {
    const refused = this.refused.get(hub)
    return refused !== undefined && refused.key === key ? refused.error : undefined
  }

  private handOff(hub: string): void {
    const queue = this.waiters.get(hub)
    const next = queue?.shift()
    if (!next) {
      this.busy.delete(hub)
      this.waiters.delete(hub)
      return
    }
    next()
  }
}

/** The HTTP client of an account mirrored from a hub while hubs are off: it reads no key and sends nothing. */
export class HubOff implements HTTPClient {
  async send(_request: HTTPRequest): Promise<HTTPResponse> {
    throw ProviderError.unavailable(CLIProxyHub.offMessage)
  }
}

/**
 * The HTTP client of an account mirrored from a hub: every request its unchanged provider client
 * sends goes out through the hub's `api-call`, as the linked login.
 */
export class HubTunnel implements HTTPClient {
  readonly link: HubLink
  readonly kind: ProviderKind
  readonly keys: HubKeyVault
  readonly client: CLIProxyHubClient

  constructor(link: HubLink, kind: ProviderKind, keys: HubKeyVault, client: CLIProxyHubClient) {
    this.link = link
    this.kind = kind
    this.keys = keys
    this.client = client
  }

  async send(request: HTTPRequest): Promise<HTTPResponse> {
    const key = this.keys.key(this.link.hubID, this.link.hubURL)
    return this.client.call(request, this.link, key, ProviderKind.displayName(this.kind))
  }
}
