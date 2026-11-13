import { AccountInitials } from '../models/AccountInitials'
import type { ProviderKind } from '../models/Account'
import { Provider } from '../models/Provider'
import type { WidgetDescriptor } from '../models/WidgetDescriptor'

/** The accounts on the dashboard and the metrics each can show. */
export class WidgetRegistry {
  readonly providers: Provider[]

  private readonly descriptorsByID = new Map<string, WidgetDescriptor>()
  private readonly providersByID = new Map<string, Provider>()
  private readonly descriptorsByProvider = new Map<string, WidgetDescriptor[]>()

  constructor(providers: Provider[], descriptors: WidgetDescriptor[]) {
    const accountCounts = new Map<ProviderKind, number>()
    for (const provider of providers) accountCounts.set(provider.kind, (accountCounts.get(provider.kind) ?? 0) + 1)
    this.providers = providers.map((provider) => {
      const copy: Provider = { ...provider }
      if ((accountCounts.get(provider.kind) ?? 0) > 1) copy.badge = AccountInitials.tag(Provider.accountName(provider))
      else delete copy.badge
      return copy
    })
    for (const descriptor of descriptors) {
      if (!this.descriptorsByID.has(descriptor.id)) this.descriptorsByID.set(descriptor.id, descriptor)
      const list = this.descriptorsByProvider.get(descriptor.providerID)
      if (list) list.push(descriptor)
      else this.descriptorsByProvider.set(descriptor.providerID, [descriptor])
    }
    for (const provider of this.providers) if (!this.providersByID.has(provider.id)) this.providersByID.set(provider.id, provider)
  }

  descriptor(id: string): WidgetDescriptor | undefined {
    return this.descriptorsByID.get(id)
  }

  provider(id: string): Provider | undefined {
    return this.providersByID.get(id)
  }

  descriptors(providerID: string): WidgetDescriptor[] {
    return this.descriptorsByProvider.get(providerID) ?? []
  }

  /** The saved order with any account it lacks placed after the last account of its kind, or at the end. */
  orderedProviderIDs(savedOrder: string[]): string[] {
    const known = new Set(this.providers.map((provider) => provider.id))
    const ordered = savedOrder.filter((id) => known.has(id))
    const savedIDs = new Set(ordered)
    for (const provider of this.providers) {
      if (savedIDs.has(provider.id)) continue
      let last = -1
      ordered.forEach((id, index) => {
        if (this.providersByID.get(id)?.kind === provider.kind) last = index
      })
      if (last >= 0) ordered.splice(last + 1, 0, provider.id)
      else ordered.push(provider.id)
    }
    return ordered
  }

  /** `WidgetRegistry.from(runtimes)` */
  static from(runtimes: { provider: Provider; widgetDescriptors: WidgetDescriptor[] }[]): WidgetRegistry {
    return new WidgetRegistry(
      runtimes.map((runtime) => runtime.provider),
      runtimes.flatMap((runtime) => runtime.widgetDescriptors)
    )
  }
}
