import { describe, expect, it } from 'vitest'
import { DashboardRowModel } from '@core/models/DashboardRowModel'
import { ProgressFormat } from '@core/models/MetricLine'
import { WidgetData } from '@core/models/WidgetData'

// Upstream drives both cases through `WidgetDataStore` (not ported yet). The store's part is choosing the
// display mode; what each mode reads is `WidgetData`, checked here with the same figures.
describe('WidgetMeterStyleTests', () => {
  it('testMeterStyleFlipsEveryBoundedFormat (model half)', () => {
    const cases: { name: string; format: ProgressFormat; used: number; limit: number; remaining: string; consumed: string }[] = [
      { name: 'percent', format: ProgressFormat.percent, used: 80, limit: 100, remaining: '20%', consumed: '80%' },
      { name: 'dollars', format: ProgressFormat.dollars, used: 80, limit: 100, remaining: '$20', consumed: '$80' },
      { name: 'count', format: ProgressFormat.count('credits'), used: 320, limit: 1_000, remaining: '680', consumed: '320' }
    ]
    const barValue = (row: DashboardRowModel): string | undefined => (row.mark.type === 'bar' ? row.mark.value : undefined)

    for (const item of cases) {
      const reading = new WidgetData({ title: 'Metric', kind: ProgressFormat.metricKind(item.format), used: item.used, limit: item.limit })

      const remaining = reading.with({ displayMode: 'remaining' })
      expect(remaining.valueText, item.name).toBe(item.remaining)
      expect(barValue(DashboardRowModel.make(remaining)), item.name).toBe(item.remaining)
      expect(remaining.fraction, item.name).toBeCloseTo(1 - item.used / item.limit, 4)

      const used = reading.with({ displayMode: 'used' })
      expect(used.valueText, item.name).toBe(item.consumed)
      expect(barValue(DashboardRowModel.make(used)), item.name).toBe(item.consumed)
      expect(used.fraction, item.name).toBeCloseTo(item.used / item.limit, 4)
    }
  })

  // testMeterStylePersistsAcrossStoreInstances needs `WidgetDataStore`.
})
