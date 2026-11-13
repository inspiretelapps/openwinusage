import { describe, expect, it } from 'vitest'
import { MetricLine, ProgressFormat } from '@core/models/MetricLine'
import { Provider } from '@core/models/Provider'
import { ProviderSnapshot } from '@core/models/ProviderSnapshot'
import { WidgetData } from '@core/models/WidgetData'
import { WidgetDescriptor } from '@core/models/WidgetDescriptor'
import { QuotaNotificationEvaluator } from '@core/stores/QuotaNotificationEvaluator'
import type { WidgetDataStore } from '@core/stores/WidgetDataStore'
import { defaultsBool, type Defaults } from '@core/support/Defaults'
import { PaceMilestone } from '@core/support/PaceNotificationLogic'
import { addSeconds, fromUnixSeconds, type Instant, type Seconds } from '@core/support/time'
import { isolatedDefaults, StubRuntime, success } from './TestSupport'
import { storeForTesting } from './support/dataStoreHelpers'

const week: Seconds = 7 * 24 * 60 * 60
const base = fromUnixSeconds(1_700_000_000)
const resetsAt = addSeconds(base, week * 0.1)

type Post = [idPrefix: string, title: string, subtitle: string, body: string]

class Recorder {
  posts: Post[] = []
}

type Notify = (now: Instant) => Promise<void>

const provider: Provider = { id: 'test', kind: 'cursor' }

function notifier(
  store: WidgetDataStore,
  descriptors: WidgetDescriptor[],
  providers: Provider[],
  settings: Defaults,
  recorder: Recorder,
  delivered: () => boolean = () => true
): Notify {
  const evaluator = new QuotaNotificationEvaluator(async (idPrefix, title, subtitle, body) => {
    recorder.posts.push([idPrefix, title, subtitle, body])
    return delivered()
  })
  return (now) =>
    evaluator.evaluate(
      descriptors,
      (descriptor) => store.data(descriptor),
      (milestone) => defaultsBool(settings, PaceMilestone.settingKey(milestone)),
      now,
      (id) => {
        const match = providers.find((candidate) => candidate.id === id)
        return match ? Provider.fullName(match) : id
      }
    )
}

function makeDescriptor(): WidgetDescriptor {
  return new WidgetDescriptor(provider, 'session', 'Session', new WidgetData({ title: 'Session', kind: 'percent', used: 10, limit: 100 }))
}

function snapshot(used: number, at: Instant = resetsAt): ProviderSnapshot {
  return ProviderSnapshot.forProvider(provider, undefined, [
    MetricLine.progress('Session', used, 100, ProgressFormat.percent, at, Math.trunc(week * 1000))
  ])
}

interface Harness {
  store: WidgetDataStore
  runtime: StubRuntime
  descriptor: WidgetDescriptor
  notify: Notify
}

function makeStore(used: number, settings: Defaults, recorder: Recorder, delivered: () => boolean = () => true): Harness {
  const descriptor = makeDescriptor()
  const runtime = StubRuntime.snapshot(provider, [descriptor], snapshot(used))
  const defaults = isolatedDefaults()
  const store = storeForTesting([runtime], { defaults })
  const notify = notifier(store, [descriptor], [provider], settings, recorder, delivered)
  return { store, runtime, descriptor, notify }
}

function allOn(settings: Defaults): void {
  for (const milestone of PaceMilestone.allCases) settings.set(PaceMilestone.settingKey(milestone), true)
}

async function evaluate(harness: Harness, used?: number, at?: Instant): Promise<void> {
  if (used !== undefined) {
    const next = snapshot(used, at)
    harness.runtime.answer = () => success(next)
  }
  await harness.store.refreshAll(true)
  await harness.notify(base)
}

describe('WidgetDataStoreNotificationTests', () => {
  it('testTwoAccountsOfOneProviderNameThemselvesInTheSubtitle', async () => {
    const settings = isolatedDefaults()
    allOn(settings)
    const recorder = new Recorder()
    const providers: Provider[] = [
      ['claude@aaaa', 'Personal'],
      ['claude@bbbb', 'Work']
    ].map(([id, accountLabel]) => ({ id, kind: 'claude', accountLabel }))
    const descriptors = providers.map(
      (account) =>
        new WidgetDescriptor(account, 'session', 'Session', new WidgetData({ title: 'Session', kind: 'percent', used: 10, limit: 100 }))
    )
    const accountSnapshot = (account: Provider, used: number): ProviderSnapshot =>
      ProviderSnapshot.forProvider(account, undefined, [
        MetricLine.progress('Session', used, 100, ProgressFormat.percent, resetsAt, Math.trunc(week * 1000))
      ])
    const runtimes = providers.map((account, index) => StubRuntime.snapshot(account, [descriptors[index]], accountSnapshot(account, 40)))
    const defaults = isolatedDefaults()
    const store = storeForTesting(runtimes, { defaults })
    const notify = notifier(store, descriptors, providers, settings, recorder)
    await store.refreshAll(true)
    await notify(base)
    expect(recorder.posts, 'more than half left should not fire').toEqual([])

    runtimes.forEach((runtime, index) => {
      const next = accountSnapshot(providers[index], 75)
      runtime.answer = () => success(next)
    })
    await store.refreshAll(true)
    await notify(base)

    expect(recorder.posts.map((post) => post[2])).toEqual(['Claude · Personal Session', 'Claude · Work Session'])
  })

  it('testUnderThirtyPercentFiresOnceThroughTheStore', async () => {
    const settings = isolatedDefaults()
    allOn(settings)
    const recorder = new Recorder()
    const harness = makeStore(40, settings, recorder)
    await evaluate(harness)
    expect(recorder.posts, 'more than half left should not fire').toEqual([])

    await evaluate(harness, 75)
    expect(recorder.posts.length).toBe(1)
    expect(recorder.posts[0]?.[0]).toBe('test.healthyToClose')
    expect(recorder.posts[0]?.[1]).toBe('Warning')
    expect(recorder.posts[0]?.[3]).toBe('30% or less left for this window.')

    await harness.notify(base)
    expect(recorder.posts.length).toBe(1)
  })

  it('testCloseToRunningOutFiresThroughTheStore', async () => {
    const settings = isolatedDefaults()
    allOn(settings)
    const recorder = new Recorder()
    const harness = makeStore(87, settings, recorder)
    await evaluate(harness)
    expect(recorder.posts, 'first launch primes the baseline without firing').toEqual([])

    await evaluate(harness, 95)
    expect(recorder.posts.some((post) => post[0] === 'test.closeToRunningOut')).toBe(true)
    expect(recorder.posts.some((post) => post[3] === 'May run out before the limit resets.')).toBe(true)
    expect(recorder.posts.some((post) => post[2] === 'Cursor Session')).toBe(true)
  })

  it('testResetJitterDoesNotRefireRunningOutThroughTheStore', async () => {
    const settings = isolatedDefaults()
    allOn(settings)
    const recorder = new Recorder()
    const harness = makeStore(80, settings, recorder)
    await evaluate(harness)

    await evaluate(harness, 95)
    expect(recorder.posts.filter((post) => post[0] === 'test.closeToRunningOut').length).toBe(1)

    await evaluate(harness, 95, addSeconds(resetsAt, 0.09))

    expect(recorder.posts.filter((post) => post[0] === 'test.closeToRunningOut').length).toBe(1)
  })

  it('testAllTogglesOffSuppressesAllPosts', async () => {
    const settings = isolatedDefaults()
    settings.set(PaceMilestone.settingKey(PaceMilestone.critical), false)
    settings.set(PaceMilestone.settingKey(PaceMilestone.warning), false)
    settings.set(PaceMilestone.settingKey(PaceMilestone.closeToRunningOut), false)
    const recorder = new Recorder()
    const harness = makeStore(80, settings, recorder)
    await evaluate(harness)
    await evaluate(harness, 95)
    expect(recorder.posts).toEqual([])
  })

  it('testAnOffTriggerDoesNotConsumeTheEdge', async () => {
    const settings = isolatedDefaults()
    settings.set(PaceMilestone.settingKey(PaceMilestone.closeToRunningOut), true)
    const recorder = new Recorder()
    const harness = makeStore(40, settings, recorder)
    await evaluate(harness)
    await evaluate(harness, 75)
    expect(recorder.posts).toEqual([])

    settings.set(PaceMilestone.settingKey(PaceMilestone.warning), true)
    await harness.notify(base)
    expect(recorder.posts.map((post) => post[0])).toEqual(['test.healthyToClose'])
  })

  it('testPerTriggerOffSuppressesThatMilestoneOnly', async () => {
    const settings = isolatedDefaults()
    allOn(settings)
    settings.set(PaceMilestone.settingKey(PaceMilestone.warning), false)
    const recorder = new Recorder()
    const harness = makeStore(40, settings, recorder)
    await evaluate(harness)
    await evaluate(harness, 75)
    expect(recorder.posts.some((post) => post[0] === 'test.healthyToClose')).toBe(false)
    await evaluate(harness, 95)
    expect(recorder.posts.some((post) => post[0] === 'test.closeToRunningOut')).toBe(true)
  })

  it('testLowRemainingFiresInUsedDisplayMode', async () => {
    const settings = isolatedDefaults()
    allOn(settings)
    const recorder = new Recorder()
    const harness = makeStore(80, settings, recorder)
    harness.store.meterStyle = 'used'
    await evaluate(harness)
    await evaluate(harness, 95)
    expect(
      recorder.posts.some((post) => post[0] === 'test.underTenPercent'),
      "Critical must fire on 10% or less remaining even when the meter displays 'used'"
    ).toBe(true)
  })

  it('testFailedDeliveryRetriesNextTick', async () => {
    const settings = isolatedDefaults()
    allOn(settings)
    const recorder = new Recorder()
    const harness = makeStore(40, settings, recorder, () => false)
    await evaluate(harness)
    await evaluate(harness, 75)
    await evaluate(harness, 75)
    expect(recorder.posts.length, 'failed delivery should retry on the next tick').toBe(2)
  })
})
