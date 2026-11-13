import { sha256Hex } from '../support/sha256'
import { addSeconds, type Instant, type Seconds } from '../support/time'
import type { HubLink } from './CLIProxyHub'

export type ProviderAuthMethod =
  | { type: 'oauth' }
  | { type: 'apiKey'; keyPage: string }
  | { type: 'organizationToken' }

/** The provider ids. `opencode` is Swift's `.opencodeGo` case; the stored and exported id is `opencode`. */
export type ProviderKind =
  | 'claude'
  | 'codex'
  | 'cursor'
  | 'antigravity'
  | 'copilot'
  | 'devin'
  | 'grok'
  | 'muse'
  | 'ollama'
  | 'opencode'
  | 'openrouter'
  | 'zai'

export interface ProviderLink {
  label: string
  url: string
}

const displayNames: Record<ProviderKind, string> = {
  claude: 'Claude',
  codex: 'ChatGPT',
  cursor: 'Cursor',
  antigravity: 'Antigravity',
  copilot: 'Copilot',
  devin: 'Devin',
  grok: 'Grok',
  muse: 'Muse Code',
  ollama: 'Ollama',
  opencode: 'OpenCode',
  openrouter: 'OpenRouter',
  zai: 'Z.ai'
}

const links: Record<ProviderKind, ProviderLink[]> = {
  claude: [
    { label: 'Status Page', url: 'https://status.claude.com/' },
    { label: 'Usage Dashboard', url: 'https://claude.ai/settings/usage' }
  ],
  codex: [
    { label: 'Status Page', url: 'https://status.openai.com/' },
    { label: 'Usage Dashboard', url: 'https://chatgpt.com/settings/usage' }
  ],
  cursor: [
    { label: 'Status Page', url: 'https://status.cursor.com/' },
    { label: 'Usage Dashboard', url: 'https://www.cursor.com/dashboard' }
  ],
  antigravity: [],
  copilot: [
    { label: 'Status Page', url: 'https://www.githubstatus.com/' },
    { label: 'Usage Dashboard', url: 'https://github.com/settings/billing' }
  ],
  devin: [{ label: 'Usage Dashboard', url: 'https://app.devin.ai/settings/plans' }],
  grok: [{ label: 'Usage Dashboard', url: 'https://grok.com/?_s=usage' }],
  muse: [{ label: 'Usage Dashboard', url: 'https://dev.meta.ai/usage' }],
  ollama: [
    { label: 'Usage Dashboard', url: 'https://ollama.com/settings' },
    { label: 'API Keys', url: 'https://ollama.com/settings/keys' }
  ],
  opencode: [
    { label: 'Status Page', url: 'https://status.opencode.ai/' },
    { label: 'Usage Dashboard', url: 'https://opencode.ai/console' }
  ],
  openrouter: [
    { label: 'Status Page', url: 'https://status.openrouter.ai/' },
    { label: 'Usage Dashboard', url: 'https://openrouter.ai/activity' },
    { label: 'Credits', url: 'https://openrouter.ai/settings/credits' }
  ],
  zai: [
    { label: 'Usage Dashboard', url: 'https://z.ai/manage-apikey/coding-plan/personal/my-plan' },
    { label: 'API Keys', url: 'https://z.ai/manage-apikey/apikey-list' }
  ]
}

const oauth: ProviderAuthMethod = { type: 'oauth' }

const authMethods: Record<ProviderKind, ProviderAuthMethod[]> = {
  claude: [oauth],
  codex: [oauth],
  cursor: [oauth],
  antigravity: [oauth],
  devin: [oauth],
  grok: [oauth],
  muse: [oauth],
  copilot: [oauth, { type: 'organizationToken' }],
  ollama: [{ type: 'apiKey', keyPage: 'https://ollama.com/settings/keys' }],
  opencode: [{ type: 'apiKey', keyPage: 'https://opencode.ai/console' }],
  openrouter: [{ type: 'apiKey', keyPage: 'https://openrouter.ai/settings/management-keys' }],
  zai: [{ type: 'apiKey', keyPage: 'https://z.ai/manage-apikey/apikey-list' }]
}

export const ProviderKind = {
  /** `ProviderKind.allCases`, in declaration order. */
  allCases: [
    'claude',
    'codex',
    'cursor',
    'antigravity',
    'copilot',
    'devin',
    'grok',
    'muse',
    'ollama',
    'opencode',
    'openrouter',
    'zai'
  ] as const satisfies readonly ProviderKind[],

  /** `ProviderKind(rawValue:)` */
  from(rawValue: unknown): ProviderKind | undefined {
    return typeof rawValue === 'string' && (ProviderKind.allCases as readonly string[]).includes(rawValue)
      ? (rawValue as ProviderKind)
      : undefined
  },

  displayName(kind: ProviderKind): string {
    return displayNames[kind]
  },

  links(kind: ProviderKind): ProviderLink[] {
    return links[kind]
  },

  authMethods(kind: ProviderKind): ProviderAuthMethod[] {
    return authMethods[kind]
  }
}

export interface Account {
  /** A lowercase UUID. */
  readonly id: string
  readonly kind: ProviderKind
  label: string
  /** A Copilot organization account carries the login whose billing its token reads; every other account has none. */
  readonly organization?: string
  /** A Copilot account signed in on GitHub Enterprise Cloud carries its GHE.com domain; a github.com account, like every other account, has none. */
  readonly domain?: string
  /** An account mirrored from a CLIProxyAPI hub carries where its login lives there; every other account has none. */
  hub?: HubLink
  readonly addedAt: Instant
}

/** A new lowercase UUID, the port of `UUID()`. */
export function newUUID(): string {
  return globalThis.crypto.randomUUID()
}

export const Account = {
  make(fields: {
    id?: string
    kind: ProviderKind
    label: string
    organization?: string
    domain?: string
    hub?: HubLink
    addedAt?: Instant
  }): Account {
    const account: Account = {
      id: (fields.id ?? newUUID()).toLowerCase(),
      kind: fields.kind,
      label: fields.label,
      addedAt: fields.addedAt ?? Date.now()
    }
    if (fields.organization !== undefined) (account as { organization?: string }).organization = fields.organization
    if (fields.domain !== undefined) (account as { domain?: string }).domain = fields.domain
    if (fields.hub !== undefined) account.hub = fields.hub
    return account
  },

  authMethod(account: Account): ProviderAuthMethod {
    return account.organization !== undefined ? { type: 'organizationToken' } : ProviderKind.authMethods(account.kind)[0]
  },

  /** The account's id everywhere outside the store: `codex@1a2b3c4d`. */
  cardID(account: Pick<Account, 'kind' | 'id'>): string {
    return `${account.kind}@${account.id.toLowerCase().slice(0, 8)}`
  }
}

export interface OAuthTokens {
  accessToken: string
  refreshToken?: string
  expiresAt?: Instant
  extras: Record<string, string>
}

export const OAuthTokens = {
  identityKey: 'account_identity',
  refreshMargin: (5 * 60) as Seconds,

  make(accessToken: string, refreshToken?: string, expiresAt?: Instant, extras: Record<string, string> = {}): OAuthTokens {
    const tokens: OAuthTokens = { accessToken, extras }
    if (refreshToken !== undefined) tokens.refreshToken = refreshToken
    if (expiresAt !== undefined) tokens.expiresAt = expiresAt
    return tokens
  },

  needsRefresh(tokens: OAuthTokens, now: Instant): boolean {
    if (tokens.refreshToken === undefined || tokens.expiresAt === undefined) return false
    return tokens.expiresAt <= addSeconds(now, OAuthTokens.refreshMargin)
  }
}

export type AccountCredential = { type: 'oauth'; tokens: OAuthTokens } | { type: 'apiKey'; key: string }

export const AccountCredential = {
  oauth(tokens: OAuthTokens): AccountCredential {
    return { type: 'oauth', tokens }
  },

  apiKey(key: string): AccountCredential {
    return { type: 'apiKey', key }
  },

  /** What tells two sign-ins of one provider apart: the login's own identity, or a hash of the key. */
  identity(credential: AccountCredential): string | undefined {
    if (credential.type === 'oauth') return credential.tokens.extras[OAuthTokens.identityKey]
    return 'key:' + sha256Hex(credential.key)
  },

  equal(a: AccountCredential | undefined, b: AccountCredential | undefined): boolean {
    return JSON.stringify(a) === JSON.stringify(b)
  }
}
