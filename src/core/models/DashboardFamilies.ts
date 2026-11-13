import { Provider } from './Provider'
import type { WidgetData } from './WidgetData'
import type { WidgetDescriptor } from './WidgetDescriptor'

/** One metric with its current reading. */
export interface DashboardLine {
  readonly descriptor: WidgetDescriptor
  readonly data: WidgetData
}

export const DashboardLine = {
  id(line: DashboardLine): string {
    return line.descriptor.id
  },

  // Spent reset grants remain available to CLI clients.
  isVisible(line: DashboardLine): boolean {
    if (!line.data.hasData) return false
    if (line.data.showsResetExpiries) return line.data.resetCreditCount > 0
    return true
  }
}

export interface DashboardAccount {
  readonly provider: Provider
  readonly lines: DashboardLine[]
  /** Before the account's first reading, the metrics it shows, each drawn as a skeleton row. */
  waitingMetricIDs: string[]
}

export const DashboardAccount = {
  make(provider: Provider, lines: DashboardLine[], waitingMetricIDs: string[] = []): DashboardAccount {
    return { provider, lines, waitingMetricIDs }
  },

  id(account: DashboardAccount): string {
    return account.provider.id
  },

  name(account: DashboardAccount): string {
    return Provider.accountName(account.provider)
  },

  hidingEmail(account: DashboardAccount): DashboardAccount {
    return { provider: Provider.hidingEmail(account.provider), lines: account.lines, waitingMetricIDs: account.waitingMetricIDs }
  }
}

/** A provider's card: every account of one kind, in dashboard order. */
export interface DashboardFamily {
  readonly id: string
  readonly provider: Provider
  accounts: DashboardAccount[]
}

/** One account's provider and the metrics it shows, in the user's order. */
export interface ProviderMetrics {
  readonly provider: Provider
  readonly metrics: WidgetDescriptor[]
}

export const DashboardFamily = {
  hidingEmails(family: DashboardFamily): DashboardFamily {
    return {
      id: family.id,
      provider: Provider.hidingEmail(family.provider),
      accounts: family.accounts.map(DashboardAccount.hidingEmail)
    }
  },

  make(
    groups: ProviderMetrics[],
    line: (descriptor: WidgetDescriptor) => DashboardLine,
    isWaiting: (provider: Provider) => boolean = () => false
  ): DashboardFamily[] {
    const families: DashboardFamily[] = []
    for (const group of groups) {
      const account = isWaiting(group.provider)
        ? DashboardAccount.make(
            group.provider,
            [],
            group.metrics.map((metric) => metric.id)
          )
        : DashboardAccount.make(group.provider, group.metrics.map(line).filter(DashboardLine.isVisible))
      const familyID = group.provider.kind
      const existing = families.find((family) => family.id === familyID)
      if (existing) existing.accounts.push(account)
      else families.push({ id: familyID, provider: group.provider, accounts: [account] })
    }
    return families
  }
}
