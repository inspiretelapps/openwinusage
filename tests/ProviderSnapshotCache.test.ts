import { describe, expect, it } from 'vitest'
import { MetricLine, ProgressFormat } from '@core/models/MetricLine'
import { metricValue } from '@core/models/MetricValue'
import { ProviderSnapshot } from '@core/models/ProviderSnapshot'
import { ProviderSnapshotCache } from '@core/stores/ProviderSnapshotCache'
import { fromUnixSeconds, type Instant } from '@core/support/time'
import { isolatedDefaults, iso } from './TestSupport'

function snapshot(id: string, used: number, now: Instant): ProviderSnapshot {
  return ProviderSnapshot.make({
    providerID: id,
    displayName: id.charAt(0).toUpperCase() + id.slice(1),
    lines: [MetricLine.progress('Session', used, 100, ProgressFormat.percent)],
    refreshedAt: now
  })
}

describe('ProviderSnapshotCacheTests', () => {
  it('testEverySaveReachesDisk', () => {
    const defaults = isolatedDefaults()
    const now = fromUnixSeconds(1_800_000_000)
    new ProviderSnapshotCache(defaults, 'k').save({
      alpha: snapshot('alpha', 10, now),
      beta: snapshot('beta', 20, now)
    })

    const reloaded = new ProviderSnapshotCache(defaults, 'k').load()
    expect(reloaded['alpha']?.lines[0]).toEqual(MetricLine.progress('Session', 10, 100, ProgressFormat.percent))
    expect(reloaded['beta']?.lines[0]).toEqual(MetricLine.progress('Session', 20, 100, ProgressFormat.percent))
    expect(reloaded['alpha']?.refreshedAt).toBe(now)
  })

  it('testAnOlderLineOnlyHistorySnapshotStillLoads', () => {
    const defaults = isolatedDefaults()
    // Wire format before history details were saved alongside their displayed lines. Upstream writes
    // Swift's Codable shape; this port saves its own JSON (a `type` per line, epoch-ms dates), so the
    // fixture is that shape without `usageBreakdowns`.
    const saved = `
      {"snapshots":{"codex@abc":{"providerID":"codex@abc","displayName":"ChatGPT","refreshedAt":${iso('2026-10-31T08:00:00Z')},
      "lines":[{"type":"values","label":"Yesterday","values":[{"number":4200,"kind":"count","label":"tokens"}],"expiriesAt":[]}]}}}
    `
    defaults.set('k', JSON.parse(saved))

    const loaded = new ProviderSnapshotCache(defaults, 'k').load()['codex@abc']
    expect(loaded).toBeDefined()
    expect(ProviderSnapshot.line(loaded, 'Yesterday')).toEqual(MetricLine.values('Yesterday', [metricValue(4200, 'count', 'tokens')]))
    expect(loaded.usageBreakdowns).toBeUndefined()
  })
})
