import type { ProviderSnapshot } from '../models/ProviderSnapshot'
import { AppLog } from '../support/AppLog'
import { asObject, isJSONObject } from '../support/ProviderParse'
import { standardDefaults, type Defaults } from '../support/Defaults'

/** The last reading of each account, kept in the preferences so it shows at launch and the command line can read it. */
export class ProviderSnapshotCache {
  static readonly defaultStorageKey = 'openusage.providerSnapshots.v12'

  constructor(
    private readonly userDefaults: Defaults = standardDefaults(),
    private readonly storageKey: string = ProviderSnapshotCache.defaultStorageKey
  ) {}

  load(): Record<string, ProviderSnapshot> {
    const stored = this.userDefaults.get(this.storageKey)
    if (stored === undefined) return {}
    const snapshots = asObject(asObject(stored)?.snapshots)
    if (!snapshots || !Object.values(snapshots).every(isSnapshot)) {
      AppLog.warn('cache', 'cache decode failed, dropping stored snapshots')
      return {}
    }
    return structuredClone(snapshots) as Record<string, ProviderSnapshot>
  }

  save(snapshots: Record<string, ProviderSnapshot>): void {
    try {
      this.userDefaults.set(this.storageKey, { snapshots: structuredClone(snapshots) })
    } catch (error) {
      AppLog.warn('cache', `encode failed, snapshot not persisted: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

function isSnapshot(value: unknown): value is ProviderSnapshot {
  if (!isJSONObject(value)) return false
  return (
    typeof value.providerID === 'string' &&
    typeof value.displayName === 'string' &&
    typeof value.refreshedAt === 'number' &&
    Array.isArray(value.lines) &&
    value.lines.every((line) => isJSONObject(line) && typeof line.label === 'string' && ['values', 'progress', 'badge'].includes(line.type as string))
  )
}
