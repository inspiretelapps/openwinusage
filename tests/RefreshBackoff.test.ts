import { describe, expect, it } from 'vitest'
import type { ProviderMetrics } from '@core/models/DashboardFamilies'
import { MetricLine, ProgressFormat } from '@core/models/MetricLine'
import type { Provider } from '@core/models/Provider'
import { NetworkError, ProviderSnapshot, RefreshFailure, type RefreshResult } from '@core/models/ProviderSnapshot'
import { WidgetData } from '@core/models/WidgetData'
import { WidgetDescriptor } from '@core/models/WidgetDescriptor'
import { ProviderError } from '@core/providers/ProviderError'
import { HTTPResponse } from '@core/services/HTTPClient'
import { RefreshSetting } from '@core/stores/RefreshSetting'
import type { WidgetDataStore } from '@core/stores/WidgetDataStore'
import { AppInfo } from '@core/support/AppInfo'
import { Formatters } from '@core/support/Formatters'
import { addSeconds, fromUnixSeconds, type Instant, type Seconds } from '@core/support/time'
import { failure, isolatedDefaults, StubRuntime, success, TestClock } from './TestSupport'
import { storeForTesting } from './support/dataStoreHelpers'

const start = fromUnixSeconds(1_800_000_000)
const provider: Provider = { id: 'test', kind: 'claude' }

function descriptor(): WidgetDescriptor {
  return new WidgetDescriptor(provider, 'weekly', 'Weekly quota', new WidgetData({ title: 'Weekly', kind: 'percent', used: 0, limit: 100 }))
}

async function assertNextAttempt(wait: Seconds, store: WidgetDataStore, runtime: StubRuntime, clock: TestClock, force: boolean): Promise<void> {
  const count = runtime.refreshCount
  const from = clock.now()
  clock.set(addSeconds(from, wait - 1))
  await store.refreshAll(force)
  expect(runtime.refreshCount, `asked before the ${Math.trunc(wait)}s wait ended`).toBe(count)
  clock.set(addSeconds(from, wait))
  await store.refreshAll()
  expect(runtime.refreshCount, `not asked once the ${Math.trunc(wait)}s wait ended`).toBe(count + 1)
}

function ok(at: Instant): RefreshResult {
  return success(
    ProviderSnapshot.forProvider(provider, undefined, [MetricLine.progress('Weekly quota', 12, 100, ProgressFormat.percent)], undefined, at)
  )
}

function rateLimited(retryAfter: Seconds | undefined): RefreshResult {
  return failure(RefreshFailure.fromError(ProviderError.rateLimited(retryAfter)))
}

function makeRuntime(results: RefreshResult[]): StubRuntime {
  return StubRuntime.results(provider, [descriptor()], results)
}

function makeStore(runtime: StubRuntime, clock: TestClock): WidgetDataStore {
  const defaults = isolatedDefaults()
  return storeForTesting([runtime], { defaults, now: clock.now })
}

function thrown(run: () => void): unknown {
  try {
    run()
  } catch (error) {
    return error
  }
  throw new Error('expected a throw')
}

describe('RefreshBackoffTests', () => {
  it('testRateLimitHonoursRetryAfterAndKeepsTheLastGoodNumbers', async () => {
    const clock = new TestClock(start)
    const runtime = makeRuntime([ok(start), rateLimited(1800), ok(start)])
    const store = makeStore(runtime, clock)

    await store.refreshAll()
    clock.set(addSeconds(start, 600))
    await store.refreshAll()
    expect(runtime.refreshCount).toBe(2)
    const retryAt = addSeconds(start, 600 + 1800)

    expect(store.errorMessage('test'), 'a provider-set wait is the clock glyph, not the warning').toBeUndefined()
    expect(store.stalenessHint('test')).toBe(
      `Claude asked ${AppInfo.name} to wait. Retrying at ${Formatters.compactClock(retryAt, clock.now())}.`
    )
    expect(store.data(descriptor()).used, 'the last good numbers stay on screen').toBe(12)

    clock.set(addSeconds(retryAt, -1))
    await store.refreshAll()
    await store.refreshAll(true)
    expect(runtime.refreshCount, 'neither the loop nor a manual refresh asks before Retry-After').toBe(2)

    clock.set(retryAt)
    expect(store.stalenessHint('test')).toBe('Last updated 40m ago')
    await store.refreshAll()
    expect(runtime.refreshCount).toBe(3)
    expect(store.backoffs['test']).toBeUndefined()
  })

  it('testPriorityStaysUnavailableAfterRetryAfterUntilTheNextSuccessfulRead', async () => {
    const clock = new TestClock(start)
    const retryAt = addSeconds(start, 60)
    const store = makeStore(makeRuntime([ok(start), rateLimited(60), ok(retryAt)]), clock)
    const group: ProviderMetrics = { provider, metrics: [descriptor()] }
    await store.refreshAll()
    await store.refreshAll(true)

    clock.set(retryAt)
    expect(store.priorityBoard([group], new Set(), clock.now()).summary).toBe('unavailable')
    expect(store.stalenessHint(provider.id)).toBe('Waiting to retry after a rate limit.')

    await store.refreshAll(true)
    expect(store.priorityBoard([group], new Set(), clock.now()).summary).toBe('allClear')
    expect(store.stalenessHint(provider.id)).toBeUndefined()
  })

  it('testTheBackoffCarriesTheFailureMessageAndShowsItUnlessTheProviderAsked', async () => {
    const clock = new TestClock(start)
    const runtime = makeRuntime([rateLimited(60), failure({ message: 'Refused', kind: { type: 'refused' } })])
    const store = makeStore(runtime, clock)

    await store.refreshAll()
    expect(store.backoffs['test']?.message).toBe(ProviderError.rateLimited(60).message)
    expect(store.errorMessage('test'), "the provider's wait keeps its message for the log, not the row").toBeUndefined()

    clock.set(addSeconds(start, 60))
    expect(store.stalenessHint('test'), 'a rate-limited first read is still pending').toBeDefined()
    await store.refreshAll()
    expect(store.backoffs['test']?.message).toBe('Refused')
    expect(store.errorMessage('test')).toBe('Refused')
  })

  it('testRateLimitWithoutRetryAfterDoublesFromFiveMinutesToAnHour', async () => {
    const clock = new TestClock(start)
    const runtime = makeRuntime([rateLimited(undefined)])
    const store = makeStore(runtime, clock)

    await store.refreshAll()
    for (const minutes of [5, 10, 20, 40, 60, 60]) {
      await assertNextAttempt(minutes * 60, store, runtime, clock, true)
    }
  })

  it('testAccountThatKeepsFailingBacksOffExponentiallyButManualRefreshRetries', async () => {
    const clock = new TestClock(start)
    const runtime = makeRuntime([failure(RefreshFailure.fromError(ProviderError.signInExpired('openrouter')))])
    const store = makeStore(runtime, clock)

    await store.refreshAll()
    for (const minutes of [5, 10, 20, 40, 60, 60]) {
      await assertNextAttempt(minutes * 60, store, runtime, clock, false)
    }
    expect(store.errorMessage('test'), 'a refused sign-in still raises the warning').toBeDefined()

    clock.set(addSeconds(clock.now(), 1))
    await store.refreshAll(true)
    expect(runtime.refreshCount, "a manual refresh skips the client's own backoff").toBe(8)
  })

  it('testSuccessResetsTheBackoff', async () => {
    const clock = new TestClock(start)
    const failed = failure(RefreshFailure.fromError(ProviderError.requestFailed(500)))
    const runtime = makeRuntime([failed, failed, failed, ok(start), failed])
    const store = makeStore(runtime, clock)

    await store.refreshAll()
    await assertNextAttempt(300, store, runtime, clock, false)
    await assertNextAttempt(600, store, runtime, clock, false)
    await assertNextAttempt(1200, store, runtime, clock, false)
    expect(store.errorMessage('test')).toBeUndefined()
    expect(store.backoffs['test']).toBeUndefined()

    clock.set(addSeconds(clock.now(), RefreshSetting.interval))
    await store.refreshAll()
    expect(runtime.refreshCount).toBe(5)
    await assertNextAttempt(300, store, runtime, clock, false)
  })

  it('testNoAnswerRetriesEveryPassWithoutGrowingTheWait', async () => {
    const clock = new TestClock(start)
    const runtime = makeRuntime([failure(RefreshFailure.fromError(new NetworkError()))])
    const store = makeStore(runtime, clock)

    await store.refreshAll()
    for (let i = 0; i < 4; i++) {
      await assertNextAttempt(300, store, runtime, clock, false)
    }
  })

  it('testRetryAfterReadsSecondsAndHTTPDates', () => {
    const response = (value: string | undefined): HTTPResponse =>
      new HTTPResponse(429, value === undefined ? {} : { 'retry-after': value })
    expect(response('120').retryAfter(start)).toBe(120)
    const date = fromUnixSeconds(1_800_000_000 + 3000)
    expect(response(new Date(date).toUTCString()).retryAfter(start)).toBe(3000)
    expect(response(undefined).retryAfter(start)).toBeUndefined()
    expect(response('0').retryAfter(start), 'a zero wait names no wait, so the doubling applies').toBeUndefined()
    expect(response('soon').retryAfter(start)).toBeUndefined()
    expect(response('18446744073709551615').retryAfter(start)).toBe(RefreshSetting.failureBackoffCap)
  })

  it('testA429ReadsAsARateLimitEverywhereRequireSuccessRuns', () => {
    const response = new HTTPResponse(429, { 'retry-after': '60' })
    const error = thrown(() => ProviderError.requireSuccess(response, 'claude'))
    expect(error instanceof ProviderError && error.equals(ProviderError.rateLimited(60))).toBe(true)
    expect(RefreshFailure.fromError(ProviderError.rateLimited(60)).kind).toEqual({ type: 'rateLimited', retryAfter: 60 })
  })

  it('testAForbiddenThatNamesARateLimitThrowsRateLimited', () => {
    const cases: [Record<string, string>, Seconds | undefined][] = [
      [{ 'x-ratelimit-remaining': '0' }, undefined],
      [{ 'retry-after': '60' }, 60]
    ]
    for (const [headers, retryAfter] of cases) {
      const response = new HTTPResponse(403, headers)
      const error = thrown(() => ProviderError.requireSuccess(response, 'copilot'))
      expect(error instanceof ProviderError && error.equals(ProviderError.rateLimited(retryAfter)), JSON.stringify(headers)).toBe(true)
    }
  })
})
