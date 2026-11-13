import { describe, expect, it } from 'vitest'
import { Account, AccountCredential, OAuthTokens } from '@core/models/Account'
import { AccountProviderRuntime } from '@core/providers/AccountProviderRuntime'
import { HTTPResponse } from '@core/services/HTTPClient'
import { ProviderSnapshotCache } from '@core/stores/ProviderSnapshotCache'
import { RefreshSetting } from '@core/stores/RefreshSetting'
import { WidgetDataStore } from '@core/stores/WidgetDataStore'
import { WidgetRegistry } from '@core/stores/WidgetRegistry'
import { InMemoryCredentialVault, isolatedDefaults, RoutingHTTPClient, TestClock, unix } from './TestSupport'

/** #1260: an Enterprise organization is billed by what it spends, so its Extra Usage row reads Spend. */
describe('ClaudeEnterpriseSpendTests', () => {
  /** The row's title after the first usage read, after the slot that reads the plan, and after the next usage read. */
  async function extraUsageTitles(organizationType: string): Promise<(string | undefined)[]> {
    const clock = new TestClock(unix(1_800_000_000))
    const http = new RoutingHTTPClient((request) => {
      const body =
        new URL(request.url).pathname === '/api/oauth/profile'
          ? `{"account":{"uuid":"acct"},"organization":{"uuid":"org","organization_type":"${organizationType}"}}`
          : '{"five_hour":null,"seven_day":null,"extra_usage":{"is_enabled":true,"monthly_limit":120000,"used_credits":41800}}'
      return new HTTPResponse(200, {}, body)
    })
    const account = Account.make({ kind: 'claude', label: 'Work' })
    const vault = new InMemoryCredentialVault()
    vault.save(AccountCredential.oauth(OAuthTokens.make('token', 'refresh')), account.id)
    const runtime = new AccountProviderRuntime(account, vault, http, clock.now)
    const defaults = isolatedDefaults()
    const store = new WidgetDataStore({
      registry: WidgetRegistry.from([runtime]),
      providers: [runtime],
      cache: new ProviderSnapshotCache(defaults, 'snapshots'),
      defaults,
      now: clock.now
    })
    const title = (): string | undefined =>
      store
        .accounts([{ provider: runtime.provider, metrics: runtime.widgetDescriptors }])
        .flatMap((shown) => shown.lines)
        .find((line) => line.descriptor.key === 'extra')?.data.title

    await store.refreshAll()
    const first = title()
    clock.set(clock.now() + (RefreshSetting.interval / 2) * 1000)
    await store.refreshHourlyReads()
    const slot = title()
    clock.set(clock.now() + RefreshSetting.interval * 1000)
    await store.refreshAll()
    return [first, slot, title()]
  }

  it('testAnEnterpriseOrganizationsExtraUsageReadsSpendOnceItsPlanIsRead', async () => {
    const enterprise = await extraUsageTitles('claude_enterprise')
    // it changes in the slot that reads the plan and stays
    expect(enterprise).toEqual(['Extra Usage', 'Spend', 'Spend'])

    const max = await extraUsageTitles('claude_max')
    expect(max).toEqual(['Extra Usage', 'Extra Usage', 'Extra Usage'])
  })
})
