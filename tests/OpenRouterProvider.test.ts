import { describe, expect, it } from 'vitest'
import { Account, AccountCredential } from '@core/models/Account'
import { MetricLine, ProgressFormat } from '@core/models/MetricLine'
import { metricValue } from '@core/models/MetricValue'
import { ProviderSnapshot } from '@core/models/ProviderSnapshot'
import { UsageBreakdown } from '@core/models/UsageHistory'
import { AccountProviderRuntime } from '@core/providers/AccountProviderRuntime'
import type { HTTPRequest, HTTPResponse } from '@core/services/HTTPClient'
import { MetricPeriod } from '@core/support/MetricPeriod'
import { OpenRouterFixtures } from './OpenRouterFixtures'
import { InMemoryCredentialVault, iso, RoutingHTTPClient } from './TestSupport'

const now = iso('2026-10-29T11:00:00Z')

function makeRuntime(handler: (request: HTTPRequest) => HTTPResponse | Promise<HTTPResponse>): { runtime: AccountProviderRuntime; http: RoutingHTTPClient } {
  const account = Account.make({ kind: 'openrouter', label: 'Work' })
  const vault = new InMemoryCredentialVault()
  vault.save(AccountCredential.apiKey('key'), account.id)
  const http = new RoutingHTTPClient(handler)
  return { runtime: new AccountProviderRuntime(account, vault, http, () => now), http }
}

/** `try await runtime.refresh().get()` */
async function refreshed(runtime: AccountProviderRuntime): Promise<ProviderSnapshot> {
  const result = await runtime.refresh()
  if (!result.ok) throw new Error(result.failure.message)
  return result.snapshot
}

function shownRows(snapshot: ProviderSnapshot, runtime: AccountProviderRuntime): string[] {
  return runtime.widgetDescriptors
    .filter((descriptor) => ProviderSnapshot.line(snapshot, descriptor.metricLabel) !== undefined)
    .map((descriptor) => descriptor.key)
}

function dollars(snapshot: ProviderSnapshot, label: string): number | undefined {
  const line = ProviderSnapshot.line(snapshot, label)
  if (line?.type !== 'values') return undefined
  return line.values[0]?.number
}

function path(request: HTTPRequest): string {
  return new URL(request.url).pathname
}

describe('OpenRouterProviderTests', () => {
  // These two read the card through `WidgetDataStore` (and `ProviderSnapshotCache`), which are not ported yet.
  it.todo('testAKeyThatSpentNothingShowsZeroDollarsAndNoBYOK')
  it.todo('testASnapshotAnEarlierBuildSavedWithBYOKIsNotShown')

  it('testAManagementKeyShowsTheAccountsSpendSummedOverEveryPageOfKeys', async () => {
    const { runtime, http } = makeRuntime(OpenRouterFixtures.managementAccount)

    const snapshot = await refreshed(runtime)

    expect(shownRows(snapshot, runtime)).toEqual(['balance', 'today', 'yesterday', 'week', 'month', 'prior30'])
    expect(dollars(snapshot, 'Today')).toBe(26.5)
    expect(dollars(snapshot, 'This Week')).toBe(54)
    expect(dollars(snapshot, 'This Month')).toBe(112)
    expect(dollars(snapshot, 'Balance')).toBe(77.75)
    expect(ProviderSnapshot.line(snapshot, 'Credits')).toBeUndefined()
    expect(snapshot.plan).toBe('Pay-as-you-go')
    expect(http.requests.map(path)).toEqual(['/api/v1/key', '/api/v1/credits', '/api/v1/keys', '/api/v1/keys', '/api/v1/activity'])
    const offsets = ['0', '100']
    http.requests.slice(2, 4).forEach((request, index) => {
      const query = [...new URL(request.url).searchParams.entries()].map(([name, value]) => `${name}=${value}`)
      expect(new Set(query)).toEqual(new Set(['include_disabled=true', 'include_expired=true', `offset=${offsets[index]}`]))
    })
  })

  it('testAWorkspaceScopedManagementKeyShowsItsWorkspacesSpendWithoutCredits', async () => {
    const { runtime, http } = makeRuntime((request) =>
      path(request) === '/api/v1/credits' ? OpenRouterFixtures.response(403, OpenRouterFixtures.forbidden) : OpenRouterFixtures.managementAccount(request)
    )

    const snapshot = await refreshed(runtime)

    expect(shownRows(snapshot, runtime)).toEqual(['today', 'yesterday', 'week', 'month', 'prior30'])
    expect(dollars(snapshot, 'Today')).toBe(26.5)
    expect(dollars(snapshot, 'This Week')).toBe(54)
    expect(dollars(snapshot, 'This Month')).toBe(112)
    expect(http.requests.map(path)).toEqual(['/api/v1/key', '/api/v1/credits', '/api/v1/keys', '/api/v1/keys', '/api/v1/activity'])
  })

  it('testAStandardKeyShowsItsOwnSpendAndLimitWithoutAskingForTheAccountsCredits', async () => {
    const { runtime, http } = makeRuntime((request) =>
      path(request) === '/api/v1/key'
        ? OpenRouterFixtures.response(200, OpenRouterFixtures.standardKey)
        : OpenRouterFixtures.response(403, OpenRouterFixtures.forbidden)
    )

    const snapshot = await refreshed(runtime)

    expect(shownRows(snapshot, runtime)).toEqual(['today', 'week', 'month', 'keyLimit', 'budget', 'freeRequests'])
    expect(ProviderSnapshot.line(snapshot, 'Today')).toEqual(MetricLine.values('Today', [metricValue(1.5, 'dollars')]))
    const today = snapshot.usageBreakdowns?.today
    expect(today === undefined ? undefined : UsageBreakdown.figures(today)).toEqual(['$1.50', '$17.38 BYOK'])
    expect(dollars(snapshot, 'This Week')).toBe(4)
    expect(dollars(snapshot, 'This Month')).toBe(12)
    expect(ProviderSnapshot.line(snapshot, 'Key Limit')).toEqual(
      MetricLine.progress('Key Limit', 25.5, 100, ProgressFormat.dollars, iso('2026-11-01T00:00:00Z'), 31 * MetricPeriod.dayMs)
    )
    expect(ProviderSnapshot.line(snapshot, 'Budget')).toEqual(
      MetricLine.progress('Budget', 32.5, 50, ProgressFormat.dollars, iso('2026-11-02T00:00:00Z'), MetricPeriod.weekMs)
    )
    expect(ProviderSnapshot.line(snapshot, 'Free Requests')).toEqual(
      MetricLine.progress('Free Requests', 12, 50, ProgressFormat.count('requests'), iso('2026-10-30T00:00:00Z'), MetricPeriod.dayMs)
    )
    expect(http.requests.map(path)).toEqual(['/api/v1/key'])
  })

  it('testRestoredRowsKeepTheirOrder', () => {
    const runtime = new AccountProviderRuntime(
      Account.make({ kind: 'openrouter', label: 'Work' }),
      new InMemoryCredentialVault(),
      new RoutingHTTPClient(() => OpenRouterFixtures.response(404))
    )

    expect(runtime.widgetDescriptors.map((descriptor) => descriptor.title)).toEqual([
      'Balance',
      'Today',
      'Yesterday',
      'This Week',
      'This Month',
      'Prior 30 Days',
      'Key Limit',
      'Budget',
      'Free Requests'
    ])
  })
})
