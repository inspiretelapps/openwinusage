import { describe, expect, it } from 'vitest'
import { Account, AccountCredential, OAuthTokens } from '@core/models/Account'
import { ProviderSnapshot, type RefreshResult } from '@core/models/ProviderSnapshot'
import type { WidgetData } from '@core/models/WidgetData'
import { AccountProviderRuntime } from '@core/providers/AccountProviderRuntime'
import { ProviderError } from '@core/providers/ProviderError'
import type { ProviderRuntime } from '@core/providers/ProviderRuntime'
import { CursorUsageClient } from '@core/providers/cursor/CursorUsageClient'
import { HTTPResponse } from '@core/services/HTTPClient'
import { ProviderSnapshotCache } from '@core/stores/ProviderSnapshotCache'
import { WidgetDataStore } from '@core/stores/WidgetDataStore'
import { WidgetRegistry } from '@core/stores/WidgetRegistry'
import type { Defaults } from '@core/support/Defaults'
import { unix, InMemoryCredentialVault, isolatedDefaults, RoutingHTTPClient, StubRuntime } from './TestSupport'

const currentPeriodUsage = `{"autoBucketModels":["fake-model"],"autoModelSelectedDisplayMessage":"fake","billingCycleEnd":"1764547200000",
 "billingCycleStart":"1761955200000","displayMessage":"fake","displayThreshold":50,"enabled":true,
 "namedModelSelectedDisplayMessage":"fake",
 "planUsage":{"apiPercentUsed":12.5,"autoPercentUsed":3.25,"bonusTooltip":"fake","limit":2000,"remaining":1500,
              "remainingBonus":false,"totalPercentUsed":25},
 "spendLimitUsage":{"individualLimit":5000,"individualRemaining":4000,"limitType":"user"}}`

const sandUsage = `{"billingBrand":"fake","currentPeriodStart":"2026-10-20T00:00:00Z","cursorPlanName":"fake","grokPlanLabel":"fake",
 "hasAvailableUsage":true,"hasNonZeroIncludedLimit":true,"usagePercent":10}`

/** `WidgetDataStore.forTesting(_:defaults:)` */
function storeForTesting(runtimes: ProviderRuntime[], defaults: Defaults): WidgetDataStore {
  return new WidgetDataStore({
    registry: WidgetRegistry.from(runtimes),
    providers: runtimes,
    cache: new ProviderSnapshotCache(defaults, 'snapshots'),
    defaults
  })
}

function makeRuntime(usage: HTTPResponse): { runtime: AccountProviderRuntime; http: RoutingHTTPClient } {
  const account = Account.make({ kind: 'cursor', label: 'Cursor Account' })
  const vault = new InMemoryCredentialVault()
  vault.save(AccountCredential.oauth(OAuthTokens.make('access', 'refresh')), account.id)
  const http = new RoutingHTTPClient((request) => {
    switch (request.url) {
      case CursorUsageClient.usageURL:
        return usage
      case CursorUsageClient.refreshURL:
        return new HTTPResponse(200, {}, '{"access_token":"renewed"}')
      case CursorUsageClient.planURL:
        return new HTTPResponse(200, {}, '{"planInfo":{"planName":"Pro"}}')
      case CursorUsageClient.creditsURL:
        return new HTTPResponse(200, {}, '{"hasCreditGrants":false}')
      case CursorUsageClient.grokBotUsageURL:
        return new HTTPResponse(200, {}, sandUsage)
      default:
        return new HTTPResponse(404, {}, new Uint8Array())
    }
  })
  return { runtime: new AccountProviderRuntime(account, vault, http), http }
}

function snapshotOf(result: RefreshResult): ProviderSnapshot {
  if (!result.ok) throw new Error(`refresh failed: ${result.failure.message}`)
  return result.snapshot
}

async function onDemandRow(usage: string): Promise<WidgetData | undefined> {
  const { runtime } = makeRuntime(new HTTPResponse(200, {}, usage))
  const snapshot = snapshotOf(await runtime.refresh())
  const stub = StubRuntime.snapshot(runtime.provider, runtime.widgetDescriptors, snapshot)
  const store = storeForTesting([stub], isolatedDefaults())
  await store.refreshAll()
  return store
    .accounts([{ provider: stub.provider, metrics: stub.widgetDescriptors }])
    .flatMap((account) => account.lines)
    .find((line) => line.descriptor.key === 'onDemand')?.data
}

describe('CursorCurrentPeriodUsageTests', () => {
  it('testTopLevelUsageFillsEveryCursorTile', async () => {
    const { runtime } = makeRuntime(new HTTPResponse(200, {}, currentPeriodUsage))

    const snapshot = snapshotOf(await runtime.refresh())

    expect(snapshot.plan).toBe('Pro')
    const total = ProviderSnapshot.line(snapshot, 'Total usage')
    if (total?.type !== 'progress') throw new Error(`Missing Total usage in ${JSON.stringify(snapshot.lines)}`)
    expect(total.used).toBe(25)
    expect(total.limit).toBe(100)
    expect(total.resetsAt).toBe(unix(1_764_547_200))
    for (const label of ['Total usage', 'Cursor Models', 'Other Models', 'On-demand', 'Grok Bot usage']) {
      expect(ProviderSnapshot.line(snapshot, label), `${label} has no line`).toBeDefined()
    }
  })

  /** #1424: a team's pooled spend limit must not read like a personal Extra Usage cap. */
  it('testATeamPoolReadsAsTeamSpendAndAPersonalCapStaysExtraUsage', async () => {
    const team = currentPeriodUsage.replaceAll(
      '"individualLimit":5000,"individualRemaining":4000,"limitType":"user"',
      '"pooledLimit":50000,"pooledUsed":12000,"pooledRemaining":38000,"limitType":"team"'
    )
    const teamRow = await onDemandRow(team)
    expect(teamRow?.title).toBe('Team Spend')
    expect(teamRow?.used).toBe(120)
    expect(teamRow?.limit).toBe(500)

    const personalRow = await onDemandRow(currentPeriodUsage)
    expect(personalRow?.title).toBe('Extra Usage')
    expect(personalRow?.limit).toBe(50)
  })

  it('testRejectedTokenReadsAsExpiredSignIn', async () => {
    const { runtime, http } = makeRuntime(new HTTPResponse(401, {}, new Uint8Array()))

    const result = await runtime.refresh()

    if (result.ok) throw new Error('Expected an error snapshot')
    expect(result.failure.message).toBe(ProviderError.signInExpired('cursor').message)
    const usageTokens = http.requests.filter((request) => request.url === CursorUsageClient.usageURL).map((request) => request.headers?.Authorization)
    // the renewed token is rejected too
    expect(usageTokens).toEqual(['Bearer access', 'Bearer renewed'])
  })
})
