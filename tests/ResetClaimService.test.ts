import { describe, it, expect } from 'vitest'
import { AppContainer } from '@core/app/AppContainer'
import { Account, AccountCredential, OAuthTokens, ProviderKind } from '@core/models/Account'
import { NetworkError } from '@core/models/ProviderSnapshot'
import { AccountProviderRuntime } from '@core/providers/AccountProviderRuntime'
import { ProviderError } from '@core/providers/ProviderError'
import type { ProviderRuntime } from '@core/providers/ProviderRuntime'
import { CodexUsageClient } from '@core/providers/codex/CodexUsageClient'
import { HTTPResponse } from '@core/services/HTTPClient'
import { MemoryHubKeyVault } from '@core/services/HubKeyVault'
import { ResetClaimFailure, ResetClaimOutcome, ResetClaimService } from '@core/services/ResetClaimService'
import { AccountStore } from '@core/stores/AccountStore'
import { ProviderSnapshotCache } from '@core/stores/ProviderSnapshotCache'
import type { RefreshOutcome } from '@core/stores/RefreshOutcome'
import { WidgetDataStore } from '@core/stores/WidgetDataStore'
import { WidgetRegistry } from '@core/stores/WidgetRegistry'
import type { Defaults } from '@core/support/Defaults'
import { OpenUsageISO8601 } from '@core/support/OpenUsageISO8601'
import type { Instant } from '@core/support/time'
import { InMemoryCredentialVault, RoutingHTTPClient, TestSwitch, isolatedDefaults, unix } from './TestSupport'

class Recorder {
  refreshes = 0
}

/** An `XCTestExpectation`: fulfilled once, and awaited with a timeout. */
class Expectation {
  private fulfilled = false
  private waiters: (() => void)[] = []

  fulfill(): void {
    this.fulfilled = true
    for (const waiter of this.waiters) waiter()
    this.waiters = []
  }

  /** Whether it was fulfilled within `seconds`. */
  async wait(seconds: number): Promise<boolean> {
    if (this.fulfilled) return true
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), seconds * 1000)
      this.waiters.push(() => {
        clearTimeout(timer)
        resolve(true)
      })
    })
  }
}

class Gate {
  private isOpen = false
  private waiting: (() => void) | undefined

  async wait(): Promise<void> {
    if (this.isOpen) return
    await new Promise<void>((resolve) => (this.waiting = resolve))
  }

  open(): void {
    this.isOpen = true
    this.waiting?.()
    this.waiting = undefined
  }
}

function makeService(outcome: ResetClaimOutcome, recorder: Recorder, refreshed: Expectation, refreshOutcomes: RefreshOutcome[] = ['refreshed']): ResetClaimService {
  return new ResetClaimService({
    accountID: 'codex@test',
    isClaimable: true,
    confirmDetail: undefined,
    claimReset: async () => outcome,
    refreshAccount: async () => {
      const answer = refreshOutcomes[Math.min(recorder.refreshes, refreshOutcomes.length - 1)]
      recorder.refreshes += 1
      refreshed.fulfill()
      return answer
    }
  })
}

/** `WidgetDataStore.forTesting(_:defaults:)` */
function storeForTesting(runtimes: ProviderRuntime[], defaults: Defaults): WidgetDataStore {
  return new WidgetDataStore({
    registry: WidgetRegistry.from(runtimes),
    providers: runtimes,
    cache: new ProviderSnapshotCache(defaults, 'snapshots'),
    defaults
  })
}

function makeCodexRuntime(http: RoutingHTTPClient): AccountProviderRuntime {
  const account = Account.make({ kind: 'codex', label: 'Work' })
  const vault = new InMemoryCredentialVault()
  vault.save(AccountCredential.oauth(OAuthTokens.make('token')), account.id)
  return new AccountProviderRuntime(account, vault, http)
}

function codexHTTP(expiry: Instant, claimed: TestSwitch<boolean>): RoutingHTTPClient {
  return new RoutingHTTPClient((request) => {
    const available = claimed.value ? 0 : 1
    switch (request.url) {
      case CodexUsageClient.usageURL:
        return new HTTPResponse(200, {}, `{"rate_limit_reset_credits":{"available_count":${available}}}`)
      case CodexUsageClient.resetCreditsURL: {
        const credit = `{"id":"RateLimitResetCredit_1","status":"available","expires_at":"${OpenUsageISO8601.string(expiry)}"}`
        return new HTTPResponse(200, {}, `{"available_count":${available},"credits":[${available === 1 ? credit : ''}]}`)
      }
      case CodexUsageClient.consumeResetCreditURL:
        claimed.value = true
        return new HTTPResponse(200, {}, '{"code":"reset"}')
      default:
        return new HTTPResponse(404, {}, new Uint8Array())
    }
  })
}

describe('ResetClaimServiceTests', () => {
  it('testClaimRefreshesTheAccountUnlessItFailed', async () => {
    const outcomes: ResetClaimOutcome[] = [
      ResetClaimOutcome.success,
      ResetClaimOutcome.nothingToReset,
      ResetClaimOutcome.noCredit,
      ResetClaimOutcome.unconfirmed,
      ResetClaimOutcome.unavailableNow(undefined),
      ResetClaimOutcome.failed('connection')
    ]
    for (const outcome of outcomes) {
      const recorder = new Recorder()
      const failed = outcome.type === 'failed'
      const refreshed = new Expectation()
      const service = makeService(outcome, recorder, refreshed)

      const result = await service.claim(Date.now(), 'redeem-1')

      expect(result).toEqual(outcome)
      expect(await refreshed.wait(failed ? 0.1 : 5), `the post-claim refresh after ${outcome.type}`).toBe(!failed)
      expect(recorder.refreshes, outcome.type).toBe(failed ? 0 : 1)
    }
  })

  it('testThePostClaimRefreshRunsOnceWhateverItReturns', async () => {
    for (const refresh of ['skipped', 'failed', 'backedOff'] as RefreshOutcome[]) {
      const recorder = new Recorder()
      const refreshed = new Expectation()
      const service = makeService(ResetClaimOutcome.success, recorder, refreshed, [refresh])

      await service.claim(Date.now(), 'redeem-1')

      expect(await refreshed.wait(5), `the post-claim refresh answering ${refresh}`).toBe(true)
      expect(recorder.refreshes, refresh).toBe(1)
    }
  })

  it('testOnlyClaudeCodexAndZAIAccountsGetAClaimService', () => {
    const http = new RoutingHTTPClient(() => new HTTPResponse(404))
    for (const kind of ProviderKind.allCases) {
      const runtime = new AccountProviderRuntime(Account.make({ kind, label: 'Work' }), new InMemoryCredentialVault(), http)
      const service = runtime.resetClaimService(async () => 'refreshed')
      switch (kind) {
        case 'claude':
          expect(service?.accountID).toBe(runtime.cardID)
          expect(service?.isClaimable, 'nothing to claim before the first reset-grants check').toBe(false)
          break
        case 'codex':
          expect(service?.accountID).toBe(runtime.cardID)
          expect(service?.isClaimable).toBe(true)
          break
        case 'zai':
          expect(service?.accountID).toBe(runtime.cardID)
          expect(service?.windowResets, 'nothing to claim before the first reset-list read').toEqual([])
          break
        default:
          expect(service, kind).toBeUndefined()
      }
    }
  })

  it('testContainerServesTheCardsClaimAndForcesItsRefreshPastTheBackoff', async () => {
    const defaults = isolatedDefaults()
    const accounts = new AccountStore({ defaults, vault: new InMemoryCredentialVault(), hubKeys: new MemoryHubKeyVault() })
    const container = new AppContainer({ accounts, defaults, http: new RoutingHTTPClient(() => new HTTPResponse(404)) })
    try {
      const codex = accounts.add({ kind: 'codex', label: 'Work', credential: AccountCredential.apiKey('key') })
      const cardID = Account.cardID(codex)
      let backedOff = false
      for (let attempt = 0; attempt < 200 && !backedOff; attempt += 1) {
        backedOff = (await container.dataStore.refresh(cardID)) === 'backedOff'
        if (!backedOff) await new Promise((resolve) => setTimeout(resolve, 5))
      }
      expect(backedOff, "the account's failed refresh puts it in the failure backoff").toBe(true)
      expect(container.resetClaim('codex@missing')).toBeUndefined()

      const service = container.resetClaim(cardID)!
      expect(service).toBeDefined()
      expect(service.accountID).toBe(cardID)
      const refresh = await service.refreshAccount()
      expect(refresh, 'the post-claim refresh runs despite the backoff').toBe('failed')
    } finally {
      container.dispose()
    }
  })

  it('testErrorsMapToTheAdviceTheMessageGives', () => {
    expect(ResetClaimFailure.from(ProviderError.signInExpired('claude'))).toBe('signInExpired')
    expect(ResetClaimFailure.from(ProviderError.signInExpired('codex'))).toBe('signInExpired')
    expect(ResetClaimFailure.from(new NetworkError('The request timed out.'))).toBe('connection')
    expect(ResetClaimFailure.from(ProviderError.connectionFailed)).toBe('connection')
    expect(ResetClaimFailure.from(ProviderError.connectionFailed)).toBe('connection')
    expect(ResetClaimFailure.from(ProviderError.requestFailed(500))).toBe('refused')
  })

  it('testEveryOutcomeGetsAPlainMessage', () => {
    const now = unix(1_800_000_000)
    const messages: [ResetClaimOutcome, string][] = [
      [ResetClaimOutcome.success, 'Reset claimed. Enjoy!'],
      [ResetClaimOutcome.nothingToReset, "Your usage doesn't need a reset yet"],
      [ResetClaimOutcome.noCredit, 'That reset is no longer available'],
      [ResetClaimOutcome.unconfirmed, 'Your reset may still be going through. Check again in a minute.'],
      [ResetClaimOutcome.unavailableNow(undefined), "Resets can't be used right now."],
      [ResetClaimOutcome.unavailableNow(now + 90 * 60 * 1000), "Resets can't be used right now. Try again in 1h 30m."],
      [ResetClaimOutcome.failed('signInExpired'), "Your sign-in expired. Sign in again from the account's page."],
      [ResetClaimOutcome.failed('notPermitted'), "This sign-in can't use resets. Use the reset in Claude Code instead."],
      [ResetClaimOutcome.failed('connection'), "Couldn't connect. Check your internet connection and try again."],
      [ResetClaimOutcome.failed('refused'), "Couldn't reset usage. Please try again."]
    ]
    for (const [outcome, text] of messages) {
      expect(ResetClaimOutcome.message(outcome, now), outcome.type).toBe(text)
    }
  })

  it('testCodexClaimRereadsTheUsageAndTheResetCountAtOnce', async () => {
    const expiry = unix(1_800_000_000)
    const http = codexHTTP(expiry, new TestSwitch(false))
    const runtime = makeCodexRuntime(http)
    const defaults = isolatedDefaults()
    const store = storeForTesting([runtime], defaults)
    const descriptor = runtime.widgetDescriptors.find((candidate) => candidate.sample.showsResetExpiries)!
    expect(descriptor).toBeDefined()
    await store.refreshAll()
    expect(store.data(descriptor).unboundedDetail).toBe('1 available')
    expect(store.data(descriptor).expiriesAt).toEqual([expiry])

    const refreshed = new Expectation()
    const service = runtime.resetClaimService(async () => {
      try {
        return await store.refresh(runtime.provider.id, true)
      } finally {
        refreshed.fulfill()
      }
    })!
    expect(service).toBeDefined()
    const sentBefore = http.requests.length
    const outcome = await service.claim(expiry, 'redeem-1')
    expect(await refreshed.wait(1)).toBe(true)

    expect(outcome).toEqual(ResetClaimOutcome.success)
    expect(http.requests.slice(sentBefore).map((request) => request.url)).toEqual([
      CodexUsageClient.resetCreditsURL,
      CodexUsageClient.consumeResetCreditURL,
      CodexUsageClient.usageURL,
      CodexUsageClient.resetCreditsURL
    ])
    expect(store.data(descriptor).unboundedDetail).toBe('0 available')
    expect(store.data(descriptor).expiriesAt).toEqual([])
  })

  it('testACodexClaimReturnsBeforeItsRefreshRuns', async () => {
    const expiry = unix(1_800_000_000)
    const runtime = makeCodexRuntime(codexHTTP(expiry, new TestSwitch(false)))
    const recorder = new Recorder()
    const gate = new Gate()
    const refreshed = new Expectation()
    const service = runtime.resetClaimService(async () => {
      await gate.wait()
      recorder.refreshes += 1
      refreshed.fulfill()
      return 'refreshed'
    })!
    expect(service).toBeDefined()

    const outcome = await service.claim(expiry, 'redeem-1')

    expect(outcome).toEqual(ResetClaimOutcome.success)
    expect(recorder.refreshes, "the claim's result shows before the refresh drops the spent row").toBe(0)
    gate.open()
    expect(await refreshed.wait(5)).toBe(true)
    expect(recorder.refreshes).toBe(1)
  })
})
