import { describe, expect, it } from 'vitest'
import { DashboardRowModel, type DashboardRowMark } from '@core/models/DashboardRowModel'
import { MetricLine, ProgressFormat } from '@core/models/MetricLine'
import { Provider } from '@core/models/Provider'
import { ProviderSnapshot } from '@core/models/ProviderSnapshot'
import { WidgetDescriptor } from '@core/models/WidgetDescriptor'
import type { WidgetDisplayMode } from '@core/models/WidgetDisplayMode'
import type { WidgetDataStore } from '@core/stores/WidgetDataStore'
import { makeDataStore } from './support/layoutSettingsHelpers'
import { StubRuntime, isolatedDefaults } from './TestSupport'

async function makePercentStore(used: number): Promise<{ store: WidgetDataStore; descriptor: WidgetDescriptor }> {
  const provider: Provider = { id: 'test', kind: 'codex' }
  const descriptor = WidgetDescriptor.percent({ key: 'metric', provider, title: 'Metric' })
  const runtime = StubRuntime.snapshot(
    provider,
    [descriptor],
    ProviderSnapshot.make({
      providerID: provider.id,
      displayName: Provider.displayName(provider),
      lines: [MetricLine.progress('Metric', used, 100, ProgressFormat.percent)]
    })
  )
  const defaults = isolatedDefaults()
  const store = makeDataStore([runtime], { defaults })
  await store.refreshAll()
  return { store, descriptor }
}

describe('WidgetPercentClampTests', () => {
  it('testOutOfRangePercentSamplesClampAcrossEveryRenderingPath', async () => {
    const cases: [string, number, number][] = [
      ['negative', -5.0, 0.0],
      ['over', 130.0, 100.0]
    ]
    for (const [suite, raw, clamped] of cases) {
      const { store, descriptor } = await makePercentStore(raw)
      const usedText = `${Math.trunc(clamped)}%`
      const remainingText = `${100 - Math.trunc(clamped)}%`

      const modes: [WidgetDisplayMode, string][] = [
        ['remaining', remainingText],
        ['used', usedText]
      ]
      for (const [mode, value] of modes) {
        store.meterStyle = mode
        const data = store.data(descriptor)
        expect(data.used, suite).toBe(clamped)
        expect(data.valueText, suite).toBe(value)
        const expected: DashboardRowMark = {
          type: 'bar',
          fill: mode === 'remaining' ? 1 - clamped / 100 : clamped / 100,
          severity: clamped === 100 ? 'critical' : 'normal',
          value,
          reset: undefined,
          isUsedUp: clamped === 100
        }
        expect(DashboardRowModel.make(data).mark, suite).toEqual(expected)
        expect(data.menuBarValue, suite).toBe(value)
      }
    }
  })
})
