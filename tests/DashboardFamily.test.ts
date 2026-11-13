import { describe, expect, it } from 'vitest'
import { DashboardAccount, DashboardFamily, type ProviderMetrics } from '@core/models/DashboardFamilies'
import { metricValue } from '@core/models/MetricValue'
import type { Provider } from '@core/models/Provider'
import { WidgetData } from '@core/models/WidgetData'
import { WidgetDescriptor } from '@core/models/WidgetDescriptor'

describe('DashboardFamilyTests', () => {
  it('testEveryMetricWithDataIsALineAndAccountsShareTheirProviderCard', () => {
    const provider = (id: string): Provider => ({ id, kind: 'claude', accountLabel: id })
    const data = (title: string, hasData = true): WidgetData => {
      const data = new WidgetData({ title, kind: 'percent', used: 10, limit: 100 })
      data.hasData = hasData
      return data
    }
    const samples: Record<string, WidgetData> = { session: data('Session'), fable: data('Fable'), weekly: data('Weekly', false) }
    const descriptor = (id: string): WidgetDescriptor =>
      new WidgetDescriptor({ id: 'claude', kind: 'claude' }, id, samples[id].title, samples[id])
    const groups: ProviderMetrics[] = [
      { provider: provider('claude@1'), metrics: ['session', 'fable', 'weekly'].map(descriptor) },
      { provider: provider('claude@2'), metrics: [descriptor('fable')] }
    ]
    const families = DashboardFamily.make(groups, (descriptor) => ({ descriptor, data: descriptor.sample }))
    expect(families.map((family) => family.id)).toEqual(['claude'])
    expect(families[0].accounts.map((account) => account.lines.map((line) => line.descriptor.key))).toEqual([
      ['session', 'fable'],
      ['fable']
    ])
  })

  it('testEachCaptionNamesItsAccount', () => {
    const family = (accounts: Provider[]): DashboardFamily => ({
      id: 'codex',
      provider: accounts[0],
      accounts: accounts.map((account) => DashboardAccount.make(account, []))
    })
    const codex = (label: string | undefined): Provider =>
      label === undefined ? { id: 'codex@plain', kind: 'codex' } : { id: `codex@${label}`, kind: 'codex', accountLabel: label }
    expect(family([codex('Sunstory')]).accounts.map(DashboardAccount.name)).toEqual(['Sunstory'])
    expect(
      family([codex('Sunstory'), codex('sam@hey.com'), codex('Codex'), codex(undefined)]).accounts.map(DashboardAccount.name)
    ).toEqual(['Sunstory', 'sam@hey.com', 'Codex', 'ChatGPT'])
  })

  it('testTheLimitResetsRowShowsOnlyWhileAResetIsAvailable', () => {
    const resets = (count: number): WidgetData => {
      const data = new WidgetData({ title: 'Rate Limit Resets', kind: 'count', used: count, limit: undefined })
      data.values = [metricValue(count, 'count', 'available')]
      data.showsResetExpiries = true
      return data
    }
    const weekly = new WidgetData({ title: 'Weekly', kind: 'percent', used: 10, limit: 100 })
    const account = (resetCount: number): DashboardAccount => {
      const samples: Record<string, WidgetData> = { resets: resets(resetCount), weekly }
      const group: ProviderMetrics = {
        provider: { id: 'codex@1', kind: 'codex' },
        metrics: ['resets', 'weekly'].map(
          (key) => new WidgetDescriptor({ id: 'codex', kind: 'codex' }, key, samples[key].title, samples[key])
        )
      }
      return DashboardFamily.make([group], (descriptor) => ({ descriptor, data: descriptor.sample }))[0].accounts[0]
    }
    expect(account(2).lines.map((line) => line.descriptor.key)).toEqual(['resets', 'weekly'])
    expect(account(0).lines.map((line) => line.descriptor.key)).toEqual(['weekly'])
  })

  // Not an upstream case: `make(groups:isWaiting:line:)` draws an account with no first reading as skeleton rows.
  it('an account still waiting for its first reading lists its metrics as skeletons', () => {
    const provider: Provider = { id: 'claude@1', kind: 'claude' }
    const weekly = WidgetDescriptor.percent({ key: 'weekly', provider, title: 'Weekly' })
    const families = DashboardFamily.make(
      [{ provider, metrics: [weekly] }],
      (descriptor) => ({ descriptor, data: descriptor.sample }),
      () => true
    )
    expect(families[0].accounts[0].lines).toEqual([])
    expect(families[0].accounts[0].waitingMetricIDs).toEqual([weekly.id])
  })
})
