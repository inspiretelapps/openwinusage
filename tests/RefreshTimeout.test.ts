import { afterEach, describe, expect, it } from 'vitest'
import { Account, AccountCredential, OAuthTokens } from '@core/models/Account'
import { MetricLine, ProgressFormat } from '@core/models/MetricLine'
import type { Provider } from '@core/models/Provider'
import { ProviderSnapshot } from '@core/models/ProviderSnapshot'
import { WidgetData } from '@core/models/WidgetData'
import { WidgetDescriptor } from '@core/models/WidgetDescriptor'
import { AccountProviderRuntime } from '@core/providers/AccountProviderRuntime'
import type { ProviderRuntime } from '@core/providers/ProviderRuntime'
import { HTTPResponse } from '@core/services/HTTPClient'
import { RefreshSetting } from '@core/stores/RefreshSetting'
import type { WidgetDataStore } from '@core/stores/WidgetDataStore'
import { addSeconds, type Clock, type Seconds } from '@core/support/time'
import {
  HangingProviderRuntime,
  HeldResponse,
  InMemoryCredentialVault,
  isolatedDefaults,
  RoutingHTTPClient,
  StubRuntime,
  TestClock,
  TestSwitch
} from './TestSupport'
import { storeForTesting, waitUntil } from './support/dataStoreHelpers'

// Not ported: testAPassJoinsAStuckKeychainReadInsteadOfStartingAnother and
// testAWriteDuringAStuckKeychainReadStillLeavesOneReadInFlight. They exercise a Keychain read that blocks
// its thread (upstream's `StallingVault`); this port's `CredentialVault` is synchronous DPAPI storage, so
// a vault read cannot stall and the runtime has no shared in-flight vault read to join.

const teardown: (() => void)[] = []
afterEach(() => {
  for (const step of teardown.splice(0)) step()
})

function makeProvider(): [Provider, WidgetDescriptor] {
  const provider: Provider = { id: 'test', kind: 'codex' }
  const descriptor = new WidgetDescriptor(provider, 'session', 'Session', new WidgetData({ title: 'Session', kind: 'percent', used: 0, limit: 100 }))
  return [provider, descriptor]
}

function makeStore(runtime: ProviderRuntime, timeout: Seconds): WidgetDataStore {
  const defaults = isolatedDefaults()
  return storeForTesting([runtime], { defaults, providerRefreshTimeout: timeout })
}

/**
 * Upstream stalls the Claude account's Keychain read; here the vault cannot stall, so the account's
 * requests are held instead once `stalled` is on. Either way the hourly read never answers.
 */
function makeClaudeRuntime(now: Clock, stalled: TestSwitch<boolean>, held: HeldResponse): AccountProviderRuntime {
  const account = Account.make({ kind: 'claude', label: 'Work' })
  const vault = new InMemoryCredentialVault()
  vault.save(AccountCredential.oauth(OAuthTokens.make('token', 'refresh')), account.id)
  const http = new RoutingHTTPClient(async () => {
    if (stalled.value) await held.hold()
    return new HTTPResponse(200, {}, '{"five_hour":{"utilization":42,"resets_at":"2099-01-01T00:00:00.000Z"}}')
  })
  return new AccountProviderRuntime(account, vault, http, now)
}

describe('RefreshTimeoutTests', () => {
  it('testHungProviderRefreshFailsAndStopsTheSpinner', async () => {
    const [provider, descriptor] = makeProvider()
    const runtime = new HangingProviderRuntime(provider, [descriptor])
    teardown.push(() => runtime.release())
    const store = makeStore(runtime, 0.05)

    const outcome = await store.refresh(provider.id, true)

    expect(outcome).toBe('failed')
    // Upstream also checks `runtime.wasCancelled`: a promise cannot be cancelled, so the store drops the
    // abandoned read's result instead (see `ProviderRefreshDeadline`), and that assertion has no port.
    expect(store.refreshingProviderIDs.size, 'the spinner must stop when the deadline wins').toBe(0)
    expect(store.errorMessage(provider.id)?.startsWith('Refresh timed out after')).toBe(true)
    const next = await store.refresh(provider.id)
    expect(next).toBe('backedOff')
  })

  it('testRefreshInsideTheDeadlineStillSucceeds', async () => {
    const [provider, descriptor] = makeProvider()
    const runtime = StubRuntime.snapshot(
      provider,
      [descriptor],
      ProviderSnapshot.forProvider(provider, undefined, [MetricLine.progress('Session', 42, 100, ProgressFormat.percent)])
    )
    const store = makeStore(runtime, 0.05)

    const outcome = await store.refresh(provider.id, true)

    expect(outcome).toBe('refreshed')
    expect(store.errorMessage(provider.id)).toBeUndefined()
    expect(store.data(descriptor).used).toBe(42)
  })

  it('testAHungHourlyReadDoesNotHoldUpTheNextPassForAnotherAccount', async () => {
    const clock = new TestClock(Date.now())
    const stalled = new TestSwitch(false)
    const held = new HeldResponse()
    const claude = makeClaudeRuntime(clock.now, stalled, held)
    const [provider, descriptor] = makeProvider()
    const other = StubRuntime.snapshot(provider, [descriptor], ProviderSnapshot.forProvider(provider, undefined, [], undefined, clock.now()))
    const store = storeForTesting([claude, other], { defaults: isolatedDefaults(), now: clock.now, providerRefreshTimeout: 0.05 })
    await store.refreshAll()
    expect(store.snapshots[claude.provider.id]).toBeDefined()
    expect(other.refreshCount).toBe(1)

    stalled.value = true
    teardown.push(() => held.release())
    void (async () => {
      clock.set(addSeconds(clock.now(), RefreshSetting.interval / 2))
      await store.refreshHourlyReads()
      clock.set(addSeconds(clock.now(), RefreshSetting.interval / 2))
      await store.refreshAll()
    })()

    await waitUntil(() => other.refreshCount === 2)
    expect(other.refreshCount, 'a Claude hourly read stuck on its stored sign-in must not hold up the next pass').toBe(2)
  })
})
