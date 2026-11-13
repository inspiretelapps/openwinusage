import { AppLog, describeError } from '../support/AppLog'
import type { Defaults } from '../support/Defaults'
import { LayoutState } from './LayoutStoreModels'

export class LayoutPersistence {
  static readonly key = 'openusage.layout.v2'

  constructor(private readonly defaults: Defaults) {}

  load(): LayoutState | undefined {
    const stored = this.defaults.get(LayoutPersistence.key)
    if (stored === undefined) return undefined
    try {
      return LayoutState.decode(stored)
    } catch (error) {
      AppLog.warn('config', `saved layout failed to decode; starting a new one: ${describeError(error)}`)
      return undefined
    }
  }

  save(state: LayoutState): void {
    try {
      this.defaults.set(LayoutPersistence.key, LayoutState.encode(state))
    } catch (error) {
      AppLog.warn('config', `failed to persist layout: ${describeError(error)}`)
    }
  }
}
