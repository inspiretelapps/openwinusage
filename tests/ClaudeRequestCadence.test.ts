import { describe, expect, it } from 'vitest'
import { Account, AccountCredential, OAuthTokens } from '@core/models/Account'
import { MetricLine } from '@core/models/MetricLine'
import { Provider } from '@core/models/Provider'
import { ProviderSnapshot, type RefreshResult } from '@core/models/ProviderSnapshot'
import { AccountProviderRuntime } from '@core/providers/AccountProviderRuntime'
import type { ProviderRuntime } from '@core/providers/ProviderRuntime'
import { ClaudeResetGrantStatus } from '@core/providers/claude/ClaudeResetGrantStatus'
import { ClaudeSessions } from '@core/providers/claude/ClaudeSession'
import type { CredentialVault } from '@core/services/AccountCredentialVault'
import { HTTPResponse, type HTTPRequest } from '@core/services/HTTPClient'
import { ResetClaimOutcome } from '@core/services/ResetClaimService'
import { ProviderSnapshotCache } from '@core/stores/ProviderSnapshotCache'
import { RefreshSetting } from '@core/stores/RefreshSetting'
import { WidgetDataStore } from '@core/stores/WidgetDataStore'
import { WidgetRegistry } from '@core/stores/WidgetRegistry'
import { AppInfo } from '@core/support/AppInfo'
import type { Defaults } from '@core/support/Defaults'
import { Formatters } from '@core/support/Formatters'
import { MetricPeriod } from '@core/support/MetricPeriod'
import { OpenUsageISO8601 } from '@core/support/OpenUsageISO8601'
import { addSeconds, type Clock, type Instant } from '@core/support/time'
import {
  HeldResponse,
  InMemoryCredentialVault,
  isClaudeResetGrantsCheck,
  iso,
  isolatedDefaults,
  jsonResponse,
  RoutingHTTPClient,
  TestClock,
  TestSwitch
} from './TestSupport'

const start = iso('2026-10-09T12:00:00.000Z')
const orgUUID = '6a9f1c2e-1b4d-4c3a-9e8f-0123456789ab'
const farFuture = iso('2099-01-01T00:00:00.000Z')

/** `WidgetDataStore.forTesting(_:defaults:now:)` */
function storeForTesting(runtimes: ProviderRuntime[], defaults: Defaults, now: Clock): WidgetDataStore {
  return new WidgetDataStore({
    registry: WidgetRegistry.from(runtimes),
    providers: runtimes,
    cache: new ProviderSnapshotCache(defaults, 'snapshots'),
    defaults,
    now
  })
}

/** `XCTestExpectation`: `fulfilled` settles once `fulfill()` is called, or fails after a second. */
function expectation(): { fulfill: () => void; fulfilled: Promise<void> } {
  let fulfill: () => void = () => undefined
  const fulfilled = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the expectation was not fulfilled within 1s')), 1000)
    fulfill = () => {
      clearTimeout(timer)
      resolve()
    }
  })
  return { fulfill, fulfilled }
}

const path = (request: HTTPRequest): string => new URL(request.url).pathname

function usage(): HTTPResponse {
  return jsonResponse('{"five_hour":{"utilization":42,"resets_at":"2099-01-01T00:00:00.000Z"}}')
}

function grants(resetsLeft: number, endsAt?: Instant): HTTPResponse {
  const endsAtJSON = endsAt === undefined ? 'null' : `"${OpenUsageISO8601.string(endsAt)}"`
  return jsonResponse(
    `{"cedar_ember":{"eligible":true,"grants":[{"id":"g","resets_left":${resetsLeft},"ends_at":${endsAtJSON}}],"next_grant_id":"g"}}`
  )
}

function anthropic(grantsAnswer: () => HTTPResponse = () => grants(1), claim: () => HTTPResponse = () => new HTTPResponse(500)): RoutingHTTPClient {
  return new RoutingHTTPClient((request) => {
    switch (path(request)) {
      case '/api/oauth/usage':
        return isClaudeResetGrantsCheck(request) ? grantsAnswer() : usage()
      case '/api/oauth/profile':
        return jsonResponse(`{"account":{"uuid":"acct"},"organization":{"uuid":"${orgUUID}","organization_type":"claude_max"}}`)
      case `/api/organizations/${orgUUID}/reset_rate_limits`:
        return claim()
      default:
        return new HTTPResponse(404)
    }
  })
}

function makeRuntime(http: RoutingHTTPClient, clock: TestClock, vault: CredentialVault = new InMemoryCredentialVault()): AccountProviderRuntime {
  const account = Account.make({ kind: 'claude', label: 'Work' })
  void vault.save(AccountCredential.oauth(OAuthTokens.make('token-a', 'refresh-a')), account.id)
  return new AccountProviderRuntime(account, vault, http, clock.now)
}

function kinds(http: RoutingHTTPClient): string[] {
  return http.requests.map((request) => {
    switch (path(request)) {
      case '/api/oauth/usage':
        return isClaudeResetGrantsCheck(request) ? 'grants' : 'usage'
      case '/api/oauth/profile':
        return 'profile'
      default:
        return path(request).endsWith('/reset_rate_limits') ? 'claim' : path(request)
    }
  })
}

function resetsAvailable(lines: MetricLine[]): number | undefined {
  const line = lines.find((candidate) => candidate.label === ClaudeResetGrantStatus.lineLabel)
  if (line?.type !== 'values') return undefined
  return line.values[0]?.number
}

/** `try result.get()` */
function get(result: RefreshResult): ProviderSnapshot {
  if (!result.ok) throw new Error(result.failure.message)
  return result.snapshot
}

/** A vault that counts its reads, as upstream's `StallingVault` does. */
class CountingVault implements CredentialVault {
  private readonly stored = new InMemoryCredentialVault()
  loads = 0

  load(id: string): AccountCredential | undefined {
    this.loads += 1
    return this.stored.load(id)
  }
  save(credential: AccountCredential, id: string): void {
    this.stored.save(credential, id)
  }
  update(credential: AccountCredential, id: string): void {
    this.stored.update(credential, id)
  }
  delete(id: string): void {
    this.stored.delete(id)
  }
}

/**
 * Anthropic budgets its usage endpoint per account and answers a reset-grants read sent right after a
 * usage read with a 429, so a pass reads plain usage only, the profile and the grants come in the
 * secondary-reads slot, a 429 holds every request to the login until its window ends (across a relaunch
 * too), and two cards for one login share one usage read.
 */
describe('ClaudeRequestCadenceTests', () => {
  it('testTheLaunchPassSendsOneRequestAndTheSlotReadsTheProfileAndGrants', async () => {
    const clock = new TestClock(start)
    const http = anthropic()
    const runtime = makeRuntime(http, clock)
    const store = storeForTesting([runtime], isolatedDefaults(), clock.now)

    await store.refreshAll()
    expect(kinds(http)).toEqual(['usage'])

    clock.set(addSeconds(start, RefreshSetting.interval / 2))
    await store.refreshHourlyReads()
    expect(kinds(http)).toEqual(['usage', 'profile', 'grants'])
    const snapshot = store.snapshots[runtime.provider.id]
    expect(snapshot).toBeDefined()
    expect(snapshot?.plan).toBe('Max')
    // the row updates in the slot, not a pass later
    expect(resetsAvailable(snapshot?.lines ?? [])).toBe(1)
  })

  it('testTheWindowHoldsAcrossARelaunch', async () => {
    const clock = new TestClock(start)
    const defaults = isolatedDefaults()
    const http = new RoutingHTTPClient(() => new HTTPResponse(429, { 'retry-after': '1800' }))
    const account = Account.make({ kind: 'claude', label: 'Work' })
    const vault = new InMemoryCredentialVault()
    vault.save(AccountCredential.oauth(OAuthTokens.make('token-a')), account.id)
    const launch = (): WidgetDataStore => {
      const runtime = new AccountProviderRuntime(account, vault, http, clock.now, new ClaudeSessions(defaults))
      return storeForTesting([runtime], defaults, clock.now)
    }
    await launch().refreshAll()
    expect(http.requests.length).toBe(1)

    clock.set(addSeconds(start, 600))
    const relaunched = launch()
    await relaunched.refreshAll()

    // nothing goes to the login inside its window
    expect(http.requests.length).toBe(1)
    const retryAt = addSeconds(start, 1800)
    expect(relaunched.stalenessHint(Account.cardID(account))).toBe(
      `Claude asked ${AppInfo.name} to wait. Retrying at ${Formatters.compactClock(retryAt, clock.now())}.`
    )
  })

  it('testTwoCardsForOneLoginSendOneUsageRequest', async () => {
    const clock = new TestClock(start)
    const http = new RoutingHTTPClient(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100))
      return usage()
    })
    const sessions = new ClaudeSessions()
    const runtimes = ['Work', 'Again'].map((label) => {
      const account = Account.make({ kind: 'claude', label })
      const vault = new InMemoryCredentialVault()
      vault.save(AccountCredential.oauth(OAuthTokens.make(`token-${label}`, undefined, undefined, { [OAuthTokens.identityKey]: 'acct/org' })), account.id)
      return new AccountProviderRuntime(account, vault, http, clock.now, sessions)
    })
    const store = storeForTesting(runtimes, isolatedDefaults(), clock.now)

    await store.refreshAll()

    expect(http.requests.length).toBe(1)
    for (const runtime of runtimes) {
      const snapshot = store.snapshots[runtime.provider.id]
      expect(snapshot === undefined ? undefined : ProviderSnapshot.line(snapshot, 'Session')).toEqual(
        MetricLine.percent('Session', 42, farFuture, MetricPeriod.sessionMs)
      )
    }
  })

  it('testAForcedRefreshReadsTheGrantsOnlyOnceTheLastCheckIsFifteenMinutesOld', async () => {
    const clock = new TestClock(start)
    const http = anthropic()
    const runtime = makeRuntime(http, clock)
    const store = storeForTesting([runtime], isolatedDefaults(), clock.now)
    await store.refreshAll()
    await store.refreshHourlyReads()

    clock.set(addSeconds(start, 5 * 60))
    await store.refreshAll(true)
    expect(kinds(http)).toEqual(['usage', 'profile', 'grants', 'usage', 'profile'])

    clock.set(addSeconds(start, RefreshSetting.forcedResetGrantsMinimumAge))
    await store.refreshAll(true)
    expect(kinds(http).slice(-3)).toEqual(['usage', 'grants', 'profile'])
  })

  it('testAClaimRefreshesTheMetersAtOnceWithoutAGrantsRead', async () => {
    const clock = new TestClock(start)
    const http = anthropic(undefined, () => jsonResponse('{"result":"reset","resets_left":0,"cleared":["five_hour"]}'))
    const runtime = makeRuntime(http, clock)
    const store = storeForTesting([runtime], isolatedDefaults(), clock.now)
    await store.refreshAll()
    await store.refreshHourlyReads()
    const refreshed = expectation()
    const service = runtime.resetClaimService(async () => {
      try {
        return await store.refresh(runtime.provider.id, true)
      } finally {
        refreshed.fulfill()
      }
    })
    if (!service) throw new Error('expected a reset claim service')
    const sentBefore = http.requests.length

    const outcome = await service.claim(start, 'redeem-1')
    await refreshed.fulfilled

    expect(outcome).toEqual(ResetClaimOutcome.success)
    expect(kinds(http).slice(sentBefore)).toEqual(['claim', 'usage'])
    expect(resetsAvailable(store.snapshots[runtime.provider.id]?.lines ?? [])).toBe(0)
  })

  it('testSpendingAGrantsLastResetLetsTheNextGrantBeClaimedAfterTheNextGrantsRead', async () => {
    const clock = new TestClock(start)
    const claimed = new TestSwitch(false)
    const http = anthropic(
      () => {
        const [left, next] = claimed.value ? [0, 'b'] : [1, 'a']
        return jsonResponse(
          `{"cedar_ember":{"eligible":true,"grants":[{"id":"a","resets_left":${left}},{"id":"b","resets_left":1}],"next_grant_id":"${next}"}}`
        )
      },
      () => {
        claimed.value = true
        return jsonResponse('{"result":"reset","resets_left":0,"cleared":["five_hour"]}')
      }
    )
    const runtime = makeRuntime(http, clock)
    const store = storeForTesting([runtime], isolatedDefaults(), clock.now)
    await store.refreshAll()
    await store.refreshHourlyReads()
    const refreshed = expectation()
    const service = runtime.resetClaimService(async () => {
      try {
        return await store.refresh(runtime.provider.id, true)
      } finally {
        refreshed.fulfill()
      }
    })
    if (!service) throw new Error('expected a reset claim service')
    const outcome = await service.claim(start, 'redeem-1')
    await refreshed.fulfilled
    expect(outcome).toEqual(ResetClaimOutcome.success)

    await store.refreshHourlyReads()

    // grant b's reset waits for the hourly grants read
    expect(runtime.resetClaimService(async () => 'refreshed')?.isClaimable).toBe(true)
  })

  // Cancels the task running the slot. A read here has no cancellation: a deadline stops waiting for it and lets it finish.
  it.todo('testAProfileReadCutShortByTheDeadlineIsRetriedInTheNextSlot')

  it('testTheSlotReadsTheProfileAndGrantsHourly', async () => {
    const clock = new TestClock(start)
    const http = anthropic()
    const runtime = makeRuntime(http, clock)

    for (let minutes = 0; minutes < 60; minutes += 5) {
      clock.set(addSeconds(start, minutes * 60))
      const snapshot = get(await runtime.refresh())
      clock.set(addSeconds(clock.now(), RefreshSetting.interval / 2))
      await runtime.refreshHourlyReads(snapshot)
    }
    expect(kinds(http).filter((kind) => kind !== 'usage')).toEqual(['profile', 'grants'])

    clock.set(addSeconds(start, RefreshSetting.interval / 2 + RefreshSetting.secondaryReadInterval))
    await runtime.refreshHourlyReads(get(await runtime.refresh()))
    expect(kinds(http).filter((kind) => kind !== 'usage')).toEqual(['profile', 'grants', 'profile', 'grants'])
  })

  it('testTheFirstSlotAfterALaunchFromTheCacheReadsTheProfileAndGrants', async () => {
    const clock = new TestClock(start)
    const http = anthropic()
    const runtime = makeRuntime(http, clock)
    const cached = ProviderSnapshot.make({ providerID: runtime.provider.id, displayName: Provider.displayName(runtime.provider), lines: [] })
    runtime.restore(cached)

    await runtime.refreshHourlyReads(cached)

    // a launch served from the cache still reads the plan and grants in the first slot
    expect(kinds(http)).toEqual(['profile', 'grants'])
  })

  it('testASlotWithNothingDueLeavesTheKeychainAlone', async () => {
    const clock = new TestClock(start)
    const vault = new CountingVault()
    const runtime = makeRuntime(anthropic(), clock, vault)
    const snapshot = get(await runtime.refresh())
    clock.set(addSeconds(start, RefreshSetting.interval / 2))
    await runtime.refreshHourlyReads(snapshot)
    const loads = vault.loads

    clock.set(addSeconds(start, (RefreshSetting.interval * 3) / 2))
    await runtime.refreshHourlyReads(snapshot)

    // a slot with no profile or grants read due must not read the stored sign-in
    expect(vault.loads).toBe(loads)
  })

  it('testARetryAfterOfZeroWaitsFiveMinutesThenTen', async () => {
    const clock = new TestClock(start)
    const http = new RoutingHTTPClient(() => new HTTPResponse(429, { 'retry-after': '0' }))
    const runtime = makeRuntime(http, clock)

    await runtime.refresh()
    for (const [offset, sent] of [
      [299, 1],
      [300, 2],
      [899, 2],
      [900, 3]
    ]) {
      clock.set(addSeconds(start, offset))
      const snapshot = await runtime.refresh()
      expect(http.requests.length, `at ${offset}s`).toBe(sent)
      expect(snapshot.ok, `at ${offset}s`).toBe(false)
    }
    clock.set(addSeconds(start, 1_000))
    const third = await runtime.refresh()
    // the third 429 waits 20 minutes
    expect(third.ok ? undefined : third.failure.kind).toEqual({ type: 'rateLimited', retryAfter: 1_100 })
  })

  it('testA429OnTheGrantsReadHoldsEveryRequestToTheLogin', async () => {
    const clock = new TestClock(start)
    const http = anthropic(() => new HTTPResponse(429, { 'retry-after': '3000' }))
    const runtime = makeRuntime(http, clock)

    await runtime.refreshHourlyReads(get(await runtime.refresh()))
    clock.set(addSeconds(start, RefreshSetting.interval))
    const gated = await runtime.refresh()

    expect(kinds(http)).toEqual(['usage', 'profile', 'grants'])
    expect(gated.ok ? undefined : gated.failure.kind).toEqual({ type: 'rateLimited', retryAfter: 3000 - RefreshSetting.interval })
  })

  it('testASuccessThatStartedBeforeA429KeepsThe429sWindow', async () => {
    const sessions = new ClaudeSessions()
    const session = sessions.session('acct/org')
    const slowRead = new HeldResponse()
    const slow = session.send(start, async () => {
      await slowRead.hold()
      return usage()
    })
    await slowRead.waitUntilHeld()
    let accepted = false
    try {
      await session.send(start, async () => new HTTPResponse(429, { 'retry-after': '600' }))
      accepted = true
    } catch {
      // The 429 is refused, as it should be.
    }
    expect(accepted, 'a 429 was accepted').toBe(false)
    slowRead.release()
    await slow

    // a success sent before the 429 must not end its window
    expect(session.wait(start)).toBe(600)
  })

  it('testTheHeldResetsRowDropsAGrantOnceItsDeadlinePasses', async () => {
    const clock = new TestClock(start)
    const deadline = addSeconds(start, 10 * 60)
    const http = anthropic(() => grants(1, deadline))
    const runtime = makeRuntime(http, clock)

    const first = await runtime.refreshHourlyReads(get(await runtime.refresh()))
    clock.set(addSeconds(start, 15 * 60))
    const later = get(await runtime.refresh())

    expect(resetsAvailable(first?.lines ?? [])).toBe(1)
    expect(resetsAvailable(later.lines)).toBe(0)
  })

  it('testAFailedGrantsReadKeepsTheLastRowForTheHour', async () => {
    const clock = new TestClock(start)
    const down = new TestSwitch(false)
    const http = anthropic(() => (down.value ? new HTTPResponse(500) : grants(1)))
    const runtime = makeRuntime(http, clock)
    await runtime.refreshHourlyReads(get(await runtime.refresh()))

    down.value = true
    clock.set(addSeconds(start, RefreshSetting.secondaryReadInterval))
    const failed = await runtime.refreshHourlyReads(get(await runtime.refresh()))
    clock.set(addSeconds(clock.now(), RefreshSetting.interval))
    const next = await runtime.refreshHourlyReads(get(await runtime.refresh()))

    const shown = get(await runtime.refresh())

    // the row the last good read showed stays
    expect(failed).toBeUndefined()
    expect(next).toBeUndefined()
    expect(resetsAvailable(shown.lines)).toBe(1)
    // a failed read waits for the next hour
    expect(kinds(http).filter((kind) => kind === 'grants').length).toBe(2)
  })

  it('testEachLoginReadsItsOwnGrants', async () => {
    const clock = new TestClock(start)
    const http = new RoutingHTTPClient((request) => {
      if (path(request) !== '/api/oauth/usage') return new HTTPResponse(404)
      if (!isClaudeResetGrantsCheck(request)) return usage()
      return grants(request.headers?.['Authorization'] === 'Bearer token-a' ? 1 : 2)
    })
    const sessions = new ClaudeSessions()
    const runtimes = ['token-a', 'token-p'].map((token) => {
      const account = Account.make({ kind: 'claude', label: token })
      const vault = new InMemoryCredentialVault()
      vault.save(AccountCredential.oauth(OAuthTokens.make(token)), account.id)
      return new AccountProviderRuntime(account, vault, http, clock.now, sessions)
    })

    const rows: (number | undefined)[] = []
    for (const runtime of runtimes) {
      rows.push(resetsAvailable((await runtime.refreshHourlyReads(get(await runtime.refresh())))?.lines ?? []))
    }

    expect(rows).toEqual([1, 2])
    expect(http.requests.filter(isClaudeResetGrantsCheck).map((request) => request.headers?.['Authorization'])).toEqual([
      'Bearer token-a',
      'Bearer token-p'
    ])
  })
})
