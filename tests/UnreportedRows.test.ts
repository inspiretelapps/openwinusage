import { describe, expect, it } from 'vitest'
import { HistoryRow } from '@core/models/HistoryRow'
import type { Provider } from '@core/models/Provider'
import { ProviderSnapshot } from '@core/models/ProviderSnapshot'
import { UsageBreakdown, UsageHistory, UsageWindow } from '@core/models/UsageHistory'
import { Calendar } from '@core/support/Calendar'
import { MetricFormatter } from '@core/support/MetricFormatter'

// The first two upstream cases need `WidgetDataStore`, `LayoutStore` and every provider's real descriptors.
describe('UnreportedRowsTests', () => {
  const provider: Provider = { id: 'codex', kind: 'codex' }
  /** Codex's range rows, restated from `AccountProviderRuntime+Descriptors.swift`. */
  const descriptors = [
    HistoryRow.descriptor('today', provider, HistoryRow.window(UsageWindow.today, 'tokens')),
    HistoryRow.descriptor('yesterday', provider, HistoryRow.window(UsageWindow.yesterday, 'tokens')),
    HistoryRow.descriptor('last30', provider, HistoryRow.window(UsageWindow.lastDays(30), 'tokens'))
  ]

  it('testARangeNothingWasReadForHasDetailsWithNothingToShow', () => {
    const utc = new Calendar('utc', 1)
    const snapshot = ProviderSnapshot.make({ providerID: 'codex', displayName: 'ChatGPT', lines: [] })

    HistoryRow.append(snapshot, descriptors, UsageHistory.make(utc, Date.now()))

    expect(snapshot.lines, 'the provider reported nothing').toEqual([])
    expect(Object.keys(snapshot.usageBreakdowns ?? {}).sort()).toEqual(['last30', 'today', 'yesterday'])
    expect(UsageBreakdown.isEmpty(snapshot.usageBreakdowns!['today'])).toBe(true)
  })

  // The model half of testEveryRangeRowReadsZeroInItsUnitWhenTheProviderReportsNothing.
  it('a range row carries the zero it reads when the provider reports nothing', () => {
    expect(descriptors.map((descriptor) => descriptor.title)).toEqual(['Today', 'Yesterday', 'Last 30 Days'])
    expect(descriptors[0].unreportedValues!.map((value) => MetricFormatter.string(value, 'row'))).toEqual(['0 tokens'])
    const cursor = HistoryRow.descriptor('today', { id: 'cursor', kind: 'cursor' }, HistoryRow.window(UsageWindow.today, 'spend', 'tokens'))
    expect(cursor.unreportedValues!.map((value) => MetricFormatter.string(value, 'row')).join(' · ')).toBe('$0 · 0 tokens')
    expect(HistoryRow.dayCount(descriptors)).toBe(30)
  })
})
