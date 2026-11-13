import { asObject } from '../support/ProviderParse'

export type { ProviderMetrics } from '../models/DashboardFamilies'

/** The user's dashboard layout. Saved as plain JSON, with the id sets as arrays. */
export interface LayoutState {
  hiddenMetricIDs: Set<string>
  /** Metrics listed under Pinned at the top of Priority. */
  priorityPinIDs: Set<string>
  providerOrder: string[]
  metricOrderByProvider: Record<string, string[]>
  /** Accounts the layout has already placed, so the user's later order is never replaced. */
  seededProviderIDs: Set<string>
}

export interface StoredLayoutState {
  hiddenMetricIDs?: string[]
  priorityPinIDs?: string[]
  providerOrder: string[]
  metricOrderByProvider: Record<string, string[]>
  seededProviderIDs: string[]
}

const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string')

export const LayoutState = {
  empty(): LayoutState {
    return { hiddenMetricIDs: new Set(), priorityPinIDs: new Set(), providerOrder: [], metricOrderByProvider: {}, seededProviderIDs: new Set() }
  },

  copy(state: LayoutState): LayoutState {
    return {
      hiddenMetricIDs: new Set(state.hiddenMetricIDs),
      priorityPinIDs: new Set(state.priorityPinIDs),
      providerOrder: [...state.providerOrder],
      metricOrderByProvider: Object.fromEntries(Object.entries(state.metricOrderByProvider).map(([id, order]) => [id, [...order]])),
      seededProviderIDs: new Set(state.seededProviderIDs)
    }
  },

  encode(state: LayoutState): StoredLayoutState {
    return {
      hiddenMetricIDs: [...state.hiddenMetricIDs].sort(),
      priorityPinIDs: [...state.priorityPinIDs].sort(),
      providerOrder: [...state.providerOrder],
      metricOrderByProvider: Object.fromEntries(Object.entries(state.metricOrderByProvider).map(([id, order]) => [id, [...order]])),
      seededProviderIDs: [...state.seededProviderIDs].sort()
    }
  },

  /** A layout saved while a build had no hiding or pins has none. Throws for anything else that is missing or misshapen. */
  decode(stored: unknown): LayoutState {
    const object = asObject(stored)
    if (!object) throw new Error('The saved layout is not an object.')
    const optionalSet = (value: unknown, name: string): Set<string> => {
      if (value === undefined || value === null) return new Set()
      if (!isStringArray(value)) throw new Error(`The saved layout's ${name} is unreadable.`)
      return new Set(value)
    }
    const order = asObject(object.metricOrderByProvider)
    if (!isStringArray(object.providerOrder) || !order || !Object.values(order).every(isStringArray) || !isStringArray(object.seededProviderIDs)) {
      throw new Error('The saved layout is missing its order.')
    }
    return {
      hiddenMetricIDs: optionalSet(object.hiddenMetricIDs, 'hiddenMetricIDs'),
      priorityPinIDs: optionalSet(object.priorityPinIDs, 'priorityPinIDs'),
      providerOrder: [...object.providerOrder],
      metricOrderByProvider: Object.fromEntries(Object.entries(order as Record<string, string[]>).map(([id, ids]) => [id, [...ids]])),
      seededProviderIDs: new Set(object.seededProviderIDs)
    }
  },

  equal(a: LayoutState, b: LayoutState): boolean {
    return JSON.stringify(LayoutState.encode(a)) === JSON.stringify(LayoutState.encode(b))
  }
}
