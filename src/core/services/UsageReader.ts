import { Account } from '../models/Account'
import { Provider } from '../models/Provider'
import { widgetDescriptors } from '../providers/AccountProviderRuntime+Descriptors'
import { AccountStore } from '../stores/AccountStore'
import { ProviderSnapshotCache } from '../stores/ProviderSnapshotCache'
import { WidgetRegistry } from '../stores/WidgetRegistry'
import type { Defaults } from '../support/Defaults'
import type { Instant } from '../support/time'
import { LimitsEnvelope } from './LimitsEnvelope'

export interface UsageReadResult {
  data: string
  hasSnapshots: boolean
}

export class UsageReaderError extends Error {
  constructor(readonly providerID: string) {
    super(`Unknown provider: ${providerID}`)
    this.name = 'UsageReaderError'
  }
}

/** Reads the stored accounts and the snapshot cache. It never refreshes and never opens the credential vault. */
export const UsageReader = {
  read(defaults: Defaults, providerID?: string, generatedAt?: Instant): UsageReadResult {
    let accounts = AccountStore.load(defaults).accounts
    if (providerID !== undefined) {
      const token = providerID.toLowerCase()
      accounts = accounts.filter((account) => Account.cardID(account) === token || account.kind === token)
      if (accounts.length === 0) throw new UsageReaderError(token)
    }
    const registry = new WidgetRegistry(accounts.map(Provider.forAccount), accounts.flatMap(widgetDescriptors))
    const snapshots = new ProviderSnapshotCache(defaults).load()
    const data = LimitsEnvelope.encode({ registry, snapshots, generatedAt })
    return { data, hasSnapshots: accounts.some((account) => snapshots[Account.cardID(account)] !== undefined) }
  }
}
