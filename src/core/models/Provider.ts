import { Account, ProviderKind, type ProviderLink } from './Account'
import { HubLink } from './CLIProxyHub'

export type { ProviderLink }

/** One account as the dashboard shows it. `id` is the account's card id (`claude@1a2b3c4d`). */
export interface Provider {
  readonly id: string
  readonly kind: ProviderKind
  accountLabel?: string
  organization?: string
  /** The GHE.com domain a Copilot account signs in at; github.com accounts have none. */
  domain?: string
  /** The host of the CLIProxyAPI hub an account is mirrored from. */
  hubHost?: string
  /** The account's initials on its tray mark. `WidgetRegistry` sets it for every account of a kind with several. */
  badge?: string
}

export const Provider = {
  /** The dashboard's view of an account (`AccountProviderRuntime.provider(for:)` upstream). */
  forAccount(account: Account): Provider {
    const provider: Provider = { id: Account.cardID(account), kind: account.kind, accountLabel: account.label }
    if (account.organization !== undefined) provider.organization = account.organization
    if (account.domain !== undefined) provider.domain = account.domain
    if (account.hub !== undefined) provider.hubHost = HubLink.host(account.hub)
    return provider
  },

  displayName(provider: Provider): string {
    return ProviderKind.displayName(provider.kind)
  },

  icon(provider: Provider): string {
    return provider.kind
  },

  links(provider: Provider): ProviderLink[] {
    return ProviderKind.links(provider.kind)
  },

  organizationBillingPage(provider: Provider): string | undefined {
    if (provider.organization === undefined) return undefined
    return `https://github.com/organizations/${encodeURIComponent(provider.organization)}/settings/billing`
  },

  accountName(provider: Provider): string {
    return provider.accountLabel !== undefined && provider.accountLabel.length > 0
      ? provider.accountLabel
      : Provider.displayName(provider)
  },

  fullName(provider: Provider): string {
    const label = Provider.labelBesideName(provider)
    return label === undefined ? Provider.displayName(provider) : `${Provider.displayName(provider)} · ${label}`
  },

  labelBesideName(provider: Provider): string | undefined {
    const label = provider.accountLabel
    if (label === undefined || label.length === 0) return undefined
    if (label.localeCompare(Provider.displayName(provider), undefined, { sensitivity: 'accent' }) === 0) return undefined
    return label
  },

  isNamedByEmail(provider: Provider): boolean {
    return provider.accountLabel?.includes('@') ?? false
  },

  hidingEmail(provider: Provider): Provider {
    if (!Provider.isNamedByEmail(provider)) return provider
    const copy = { ...provider }
    delete copy.accountLabel
    return copy
  }
}
