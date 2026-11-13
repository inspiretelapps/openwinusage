import type { ProviderMetrics } from '../models/DashboardFamilies'
import type { Provider } from '../models/Provider'
import type { WidgetDescriptor } from '../models/WidgetDescriptor'
import { standardDefaults, type Defaults } from '../support/Defaults'
import { Observable } from '../support/Observable'
import { LayoutPersistence } from './LayoutPersistence'
import { LayoutState } from './LayoutStoreModels'
import type { WidgetRegistry } from './WidgetRegistry'

/**
 * The user's layout: which metrics are hidden or pinned, and the order of providers, accounts, and
 * metrics, with undo. Upstream splits this across `LayoutStore.swift` and `LayoutStore+Customization.swift`.
 */
export class LayoutStore extends Observable {
  static readonly maxUndoDepth = 40

  state = LayoutState.empty()
  private undoSnapshots: LayoutState[] = []

  registry: WidgetRegistry
  private readonly persistence: LayoutPersistence

  constructor(registry: WidgetRegistry, defaults: Defaults = standardDefaults()) {
    super()
    this.registry = registry
    this.persistence = new LayoutPersistence(defaults)
    this.loadLayout()
  }

  apply(registry: WidgetRegistry): void {
    const next = new Set(registry.providers.map((provider) => provider.id))
    const current = new Set(this.registry.providers.map((provider) => provider.id))
    if (next.size !== current.size || [...next].some((id) => !current.has(id))) this.undoSnapshots = []
    this.registry = registry
    this.loadLayout()
    this.notify()
  }

  private loadLayout(): void {
    const saved = this.persistence.load() ?? LayoutState.empty()
    const unseeded = this.registry.providers.filter((provider) => !saved.seededProviderIDs.has(provider.id))
    // Upstream gives the only account of a provider that provider's 0.7.x layout here. This port has no 0.7.x to carry over.
    for (const provider of unseeded) saved.seededProviderIDs.add(provider.id)
    if (unseeded.length > 0) {
      saved.providerOrder = this.registry.orderedProviderIDs(saved.providerOrder)
      this.persistence.save(saved)
    }

    const registry = this.registry
    this.state = {
      hiddenMetricIDs: new Set([...saved.hiddenMetricIDs].filter((id) => registry.descriptor(id) !== undefined)),
      priorityPinIDs: new Set([...saved.priorityPinIDs].filter((id) => registry.descriptor(id) !== undefined)),
      providerOrder: saved.providerOrder,
      metricOrderByProvider: Object.fromEntries(Object.entries(saved.metricOrderByProvider).filter(([id]) => registry.provider(id) !== undefined)),
      seededProviderIDs: new Set([...saved.seededProviderIDs].filter((id) => registry.provider(id) !== undefined))
    }
  }

  isMetricShown(descriptorID: string): boolean {
    return !this.state.hiddenMetricIDs.has(descriptorID)
  }

  /** Shows or hides a metric everywhere. Hiding a pinned metric unpins it. Returns whether anything changed. */
  setMetricShown(descriptorID: string, shown: boolean): boolean {
    return this.recordingUndoStep(() => {
      if (this.registry.descriptor(descriptorID) === undefined) return false
      if (shown) return this.state.hiddenMetricIDs.delete(descriptorID)
      this.state.priorityPinIDs.delete(descriptorID)
      if (this.state.hiddenMetricIDs.has(descriptorID)) return false
      this.state.hiddenMetricIDs.add(descriptorID)
      return true
    })
  }

  isMetricPinned(descriptorID: string): boolean {
    return this.state.priorityPinIDs.has(descriptorID)
  }

  /** Only a shown metric can be pinned. Returns whether anything changed. */
  setMetricPinned(descriptorID: string, pinned: boolean): boolean {
    return this.recordingUndoStep(() => {
      if (this.registry.descriptor(descriptorID) === undefined) return false
      if (!pinned) return this.state.priorityPinIDs.delete(descriptorID)
      if (!this.isMetricShown(descriptorID) || this.state.priorityPinIDs.has(descriptorID)) return false
      this.state.priorityPinIDs.add(descriptorID)
      return true
    })
  }

  get canUndo(): boolean {
    return this.undoSnapshots.length > 0
  }

  recordingUndoStep(reorder: () => boolean): boolean {
    const before = LayoutState.copy(this.state)
    if (!reorder()) {
      // A step that reports no change must leave nothing half-done behind.
      if (!LayoutState.equal(before, this.state)) this.state = before
      return false
    }
    this.undoSnapshots.push(before)
    if (this.undoSnapshots.length > LayoutStore.maxUndoDepth) this.undoSnapshots.shift()
    this.persistence.save(this.state)
    this.notify()
    return true
  }

  undo(): boolean {
    const snapshot = this.undoSnapshots.pop()
    if (!snapshot) return false
    this.state = snapshot
    this.persistence.save(this.state)
    this.notify()
    return true
  }

  metricOrder(providerID: string): string[] {
    const valid = this.registry.descriptors(providerID).map((descriptor) => descriptor.id)
    const validSet = new Set(valid)
    const seen = new Set<string>()
    const saved = (this.state.metricOrderByProvider[providerID] ?? []).filter((id) => {
      if (!validSet.has(id) || seen.has(id)) return false
      seen.add(id)
      return true
    })
    return [...saved, ...valid.filter((id) => !seen.has(id))]
  }

  // LayoutStore+Customization.swift

  provider(id: string): Provider | undefined {
    return this.registry.provider(id)
  }

  get visibleDescriptors(): WidgetDescriptor[] {
    return this.displayGroups.flatMap((group) => group.metrics)
  }

  orderedProviderIDs(): string[] {
    return this.registry.orderedProviderIDs(this.state.providerOrder)
  }

  orderedProviders(): Provider[] {
    return this.orderedProviderIDs()
      .map((id) => this.registry.provider(id))
      .filter((provider): provider is Provider => provider !== undefined)
  }

  /** Each account with the metrics it shows, in the user's order. An account with every metric hidden is left out. */
  get displayGroups(): ProviderMetrics[] {
    const groups: ProviderMetrics[] = []
    for (const provider of this.orderedProviders()) {
      const metrics = this.orderedSupportedMetrics(provider.id).filter((metric) => this.isMetricShown(metric.id))
      if (metrics.length > 0) groups.push({ provider, metrics })
    }
    return groups
  }

  orderedSupportedMetrics(providerID: string): WidgetDescriptor[] {
    return this.metricOrder(providerID)
      .map((id) => this.registry.descriptor(id))
      .filter((descriptor): descriptor is WidgetDescriptor => descriptor !== undefined)
  }

  /** An account moves past another provider only when both providers have one account. */
  reorderProvider(dragged: string, target: string): boolean {
    const from = this.provider(dragged)?.kind
    const to = this.provider(target)?.kind
    if (from === undefined || to === undefined) return false
    if (from !== to && this.registry.providers.filter((provider) => provider.kind === from || provider.kind === to).length !== 2) return false
    return this.recordingUndoStep(() => {
      const next = LayoutStore.reordered(this.orderedProviderIDs(), dragged, target)
      if (!next) return false
      this.state.providerOrder = next
      return true
    })
  }

  /** Moves a whole provider card (every account of one kind). `dragged` and `target` are provider kinds. */
  reorderFamily(dragged: string, target: string): boolean {
    return this.recordingUndoStep(() => {
      const families: string[] = []
      const members = new Map<string, string[]>()
      for (const provider of this.orderedProviders()) {
        const family = provider.kind
        const list = members.get(family)
        if (list) list.push(provider.id)
        else {
          families.push(family)
          members.set(family, [provider.id])
        }
      }
      const next = LayoutStore.reordered(families, dragged, target)
      if (!next) return false
      this.state.providerOrder = next.flatMap((family) => members.get(family) ?? [])
      return true
    })
  }

  reorderMetric(dragged: string, target: string, providerID: string): boolean {
    return this.recordingUndoStep(() => {
      const next = LayoutStore.reordered(this.metricOrder(providerID), dragged, target)
      if (!next) return false
      this.state.metricOrderByProvider[providerID] = next
      return true
    })
  }

  /**
   * Pure reorder: remove `dragged`, reinsert it adjacent to `target` (after it when moving down, before
   * it when moving up). Returns undefined when either id is missing or they're identical. Mirrors the proven
   * macOS drag-reorder math from crafcat7/Peakmon (Apache-2.0).
   */
  static reordered(ids: string[], dragged: string, target: string): string[] | undefined {
    if (dragged === target) return undefined
    const from = ids.indexOf(dragged)
    const to = ids.indexOf(target)
    if (from < 0 || to < 0) return undefined
    const next = [...ids]
    next.splice(from, 1)
    const adjusted = next.indexOf(target)
    if (adjusted < 0) return undefined
    const insert = from < to ? adjusted + 1 : adjusted
    next.splice(Math.min(insert, next.length), 0, dragged)
    return next
  }
}
