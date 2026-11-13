import { ProviderParse, asArray, asObject, asString } from '../support/ProviderParse'
import type { Instant } from '../support/time'
import { AppInfo } from '../support/AppInfo'
import { AccountCredential, OAuthTokens, newUUID, type Account, type ProviderKind } from './Account'

/**
 * What a hub-mirrored account stores as its access token: the hub swaps it for the login's own token.
 * `CLIProxyHubClient.tokenPlaceholder` is this same value.
 */
export const hubTokenPlaceholder = '$TOKEN$'

/**
 * A CLIProxyAPI server the user connected with its management key. The hub owns its list of logins;
 * each supported login is mirrored as an ordinary Claude, ChatGPT, Antigravity, Devin, or Grok account
 * that carries a `HubLink`.
 */
export interface CLIProxyHub {
  readonly id: string
  readonly url: string
  readonly addedAt: Instant
}

function parseURL(text: string): URL | undefined {
  try {
    return new URL(text)
  } catch {
    return undefined
  }
}

export const CLIProxyHub = {
  /** The bundled mark (`cliproxyapi.svg`) on the hub's row and on its accounts' badge. */
  markID: 'cliproxyapi',
  /** The hub's off switch: while false, Add Account offers no hub, and a stored hub or an account's hub link reads no key and sends nothing. */
  isEnabled: true,
  offMessage: `CLIProxyAPI hubs are turned off in this version of ${AppInfo.name}.`,

  make(url: string, id: string = newUUID(), addedAt: Instant = Date.now()): CLIProxyHub {
    return { id: id.toLowerCase(), url, addedAt }
  },

  host(hub: CLIProxyHub): string {
    return CLIProxyHub.hostOf(hub.url)
  },

  /** `host` or `host:port`, with the port only when the URL names one. */
  hostOf(url: string): string {
    const parsed = parseURL(url)
    if (!parsed || parsed.hostname.length === 0) return url
    return parsed.port.length > 0 ? `${parsed.hostname}:${parsed.port}` : parsed.hostname
  },

  /**
   * The hub's base URL from what the user typed: the scheme defaults to https, and the query, the
   * fragment, and a pasted panel or API path (`/management.html`, `/v0/management`, `/v1`) are
   * dropped. A path the hub sits under behind a reverse proxy is kept.
   */
  baseURL(input: string): string | undefined {
    let text = input.trim()
    if (text.length === 0) return undefined
    if (!text.includes('://')) text = 'https://' + text
    const url = parseURL(text)
    if (!url) return undefined
    const scheme = url.protocol.replace(/:$/, '').toLowerCase()
    if (scheme !== 'http' && scheme !== 'https') return undefined
    if (url.hostname.length === 0) return undefined
    let path = url.pathname
    const suffixes = ['/', '/management.html', '/v0/management', '/v8/management', '/v1']
    let trimmed = true
    while (trimmed) {
      trimmed = false
      for (const suffix of suffixes) {
        while (path.toLowerCase().endsWith(suffix)) {
          path = path.slice(0, -suffix.length)
          trimmed = true
        }
      }
    }
    return `${scheme}://${url.host}${path}`
  },

  /**
   * Whether the management key may go to `url` at all: over https anywhere, and over http only to
   * this computer, a host on the local network (a private or link-local address, or a `.local` name), or a
   * Tailscale peer (a `.ts.net` name or an address in 100.64.0.0/10 or fd7a:115c:a1e0::/48), whose
   * traffic WireGuard encrypts.
   */
  allowsKey(url: string): boolean {
    const parsed = parseURL(url)
    if (!parsed) return false
    const scheme = parsed.protocol.replace(/:$/, '')
    if (scheme !== 'http') return scheme === 'https'
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    if (host.length === 0) return false
    if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.ts.net')) return true
    if (host.includes(':')) return host === '::1' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')
    const parts = host.split('.')
    if (parts.length !== 4) return false
    const octets = parts.map((part) => (/^\d{1,3}$/.test(part) && Number(part) <= 255 ? Number(part) : undefined))
    if (octets.some((octet) => octet === undefined)) return false
    const [a, b] = octets as number[]
    return (
      a === 127 ||
      a === 10 ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 100 && b >= 64 && b <= 127)
    )
  }
}

/**
 * Where a mirrored account's login lives on its hub. `loginID` is the hub's stable id for the login
 * (its file name); `authIndex` is what `api-call` takes, and it changes when the hub renames the file.
 * `chatGPTAccountID` is the ChatGPT workspace a Codex login is signed in to, which can change under the
 * same file.
 */
export interface HubLink {
  readonly hubID: string
  readonly hubURL: string
  readonly loginID: string
  authIndex: string
  chatGPTAccountID?: string
}

export const HubLink = {
  /** Undefined for a login the hub listed without an auth index, which can't be called. */
  make(hub: CLIProxyHub, login: HubLogin): HubLink | undefined {
    if (login.authIndex === undefined) return undefined
    const link: HubLink = { hubID: hub.id, hubURL: hub.url, loginID: login.id, authIndex: login.authIndex }
    if (login.chatGPTAccountID !== undefined) link.chatGPTAccountID = login.chatGPTAccountID
    return link
  },

  host(link: HubLink): string {
    return CLIProxyHub.hostOf(link.hubURL)
  },

  /** The account's stored sign-in: the hub's placeholder, which the hub swaps for its own token. */
  credential(link: HubLink): AccountCredential {
    return AccountCredential.oauth(
      OAuthTokens.make(
        hubTokenPlaceholder,
        undefined,
        undefined,
        link.chatGPTAccountID !== undefined ? { chatgpt_account_id: link.chatGPTAccountID } : {}
      )
    )
  },

  equal(a: HubLink | undefined, b: HubLink | undefined): boolean {
    if (a === undefined || b === undefined) return a === b
    return (
      a.hubID === b.hubID &&
      a.hubURL === b.hubURL &&
      a.loginID === b.loginID &&
      a.authIndex === b.authIndex &&
      a.chatGPTAccountID === b.chatGPTAccountID
    )
  }
}

/** One entry of the hub's `GET /v0/management/auth-files` listing, reduced to what the app reads. */
export interface HubLogin {
  readonly id: string
  /** Undefined when the hub listed the login without one; such a login can't be called. */
  readonly authIndex?: string
  readonly provider: string
  readonly label: string
  readonly isOAuth: boolean
  readonly isDisabled: boolean
  readonly chatGPTAccountID?: string
}

export const HubLogin = {
  /** The provider a login is mirrored as, or undefined for a login the app doesn't support yet. */
  kind(login: HubLogin): ProviderKind | undefined {
    if (!login.isOAuth) return undefined
    switch (login.provider) {
      case 'claude':
        return 'claude'
      case 'codex':
        return 'codex'
      case 'antigravity':
        return 'antigravity'
      case 'devin':
        return 'devin'
      case 'xai':
        return 'grok'
      default:
        return undefined
    }
  },

  /** An enabled login the app can't mirror. A file the hub couldn't read lists as provider `unknown` and isn't a login at all. */
  isUnsupported(login: HubLogin): boolean {
    return !login.isDisabled && HubLogin.kind(login) === undefined && login.provider !== 'unknown'
  },

  /** The listing's logins in hub order. An entry without an id is skipped; an undecodable body throws. */
  listing(body: Uint8Array | string): HubLogin[] {
    const files = asArray(ProviderParse.jsonObject(body)?.files)
    if (!files) throw new Error('The CLIProxyAPI hub returned a login list that could not be read.')
    const optionalString = (value: unknown, field: string): string | undefined => {
      if (value === undefined || value === null) return undefined
      if (typeof value !== 'string') throw new Error(`The CLIProxyAPI hub listed a login with an unreadable ${field}.`)
      return value
    }
    const logins: HubLogin[] = []
    for (const raw of files) {
      const entry = asObject(raw)
      if (!entry) throw new Error('The CLIProxyAPI hub returned a login list that could not be read.')
      const id = optionalString(entry.id, 'id')
      if (id === undefined || id.length === 0) continue
      const authIndexRaw = optionalString(entry.auth_index, 'auth_index')
      const authIndex = authIndexRaw !== undefined && authIndexRaw.length > 0 ? authIndexRaw : undefined
      const provider = (optionalString(entry.provider, 'provider') ?? optionalString(entry.type, 'type') ?? '').toLowerCase()
      const label =
        [entry.email, entry.account, entry.label, entry.name]
          .map((value, index) => optionalString(value, ['email', 'account', 'label', 'name'][index])?.trim())
          .find((value) => value !== undefined && value.length > 0) ?? id
      const disabled = entry.disabled
      if (disabled !== undefined && disabled !== null && typeof disabled !== 'boolean') {
        throw new Error('The CLIProxyAPI hub listed a login with an unreadable disabled flag.')
      }
      const login: {
        id: string
        authIndex?: string
        provider: string
        label: string
        isOAuth: boolean
        isDisabled: boolean
        chatGPTAccountID?: string
      } = {
        id,
        provider,
        label,
        isOAuth: (optionalString(entry.account_type, 'account_type') ?? 'oauth').toLowerCase() === 'oauth',
        isDisabled: disabled ?? false
      }
      if (authIndex !== undefined) login.authIndex = authIndex
      const idToken = entry.id_token
      if (idToken !== undefined && idToken !== null) {
        const token = asObject(idToken)
        if (!token) throw new Error('The CLIProxyAPI hub listed a login with an unreadable id token.')
        const chatGPTAccountID = asString(token.chatgpt_account_id)
        if (chatGPTAccountID !== undefined) login.chatGPTAccountID = chatGPTAccountID
      }
      logins.push(login)
    }
    return logins
  }
}

/**
 * What it takes to make a hub's mirrored accounts match its login list, in the listing's order. A login
 * disabled on the hub counts as gone. A login missing from the list is removed only when the previous
 * list lacked it too, so a hub that answers mid-restart, or with a list cut short, never erases accounts.
 * A login listed without an auth index keeps its account as it is.
 */
export interface HubReconciliation {
  added: { kind: ProviderKind; label: string; link: HubLink }[]
  removed: string[]
  relinked: Map<string, HubLink>
  /** The accounts whose logins this list lacks for the first time; they stay until the next list agrees. */
  missing: Set<string>
}

export const HubReconciliation = {
  make(hub: CLIProxyHub, logins: HubLogin[], accounts: Account[], missingBefore: Set<string>): HubReconciliation {
    const listed = new Map<string, HubLogin>()
    for (const login of logins) if (!listed.has(login.id)) listed.set(login.id, login)
    const mirroredIDs = new Set<string>()
    const removed: string[] = []
    const relinked = new Map<string, HubLink>()
    const missing = new Set<string>()

    for (const account of accounts) {
      const link = account.hub
      if (!link || link.hubID !== hub.id) continue
      const login = listed.get(link.loginID)
      if (!login) {
        if (missingBefore.has(account.id)) removed.push(account.id)
        else missing.add(account.id)
        continue
      }
      if (login.isDisabled || HubLogin.kind(login) !== account.kind || mirroredIDs.has(login.id)) {
        removed.push(account.id)
        continue
      }
      mirroredIDs.add(login.id)
      const current = HubLink.make(hub, login)
      if (current && !HubLink.equal(current, link)) relinked.set(account.id, current)
    }

    const added: HubReconciliation['added'] = []
    for (const login of logins) {
      if (login.isDisabled) continue
      const kind = HubLogin.kind(login)
      if (kind === undefined) continue
      const link = HubLink.make(hub, login)
      if (!link || mirroredIDs.has(login.id)) continue
      mirroredIDs.add(login.id)
      added.push({ kind, label: login.label, link })
    }
    return { added, removed, relinked, missing }
  },

  isEmpty(reconciliation: HubReconciliation): boolean {
    return reconciliation.added.length === 0 && reconciliation.removed.length === 0 && reconciliation.relinked.size === 0
  }
}
