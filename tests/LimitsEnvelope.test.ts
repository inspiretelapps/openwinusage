import { describe, expect, it } from 'vitest'
import { Account, ProviderKind } from '@core/models/Account'
import { LimitResourceSource } from '@core/models/LimitResourceDescriptor'
import { MetricLine, ProgressFormat } from '@core/models/MetricLine'
import { metricValue } from '@core/models/MetricValue'
import type { Provider } from '@core/models/Provider'
import { ProviderSnapshot } from '@core/models/ProviderSnapshot'
import { WidgetDescriptor } from '@core/models/WidgetDescriptor'
import { AccountProviderRuntime } from '@core/providers/AccountProviderRuntime'
import { widgetDescriptors } from '@core/providers/AccountProviderRuntime+Descriptors'
import { AntigravityMetric } from '@core/providers/antigravity/AntigravityMetric'
import { CodexUsageMapper } from '@core/providers/codex/CodexUsageMapper'
import { HTTPResponse } from '@core/services/HTTPClient'
import { LimitsEnvelope } from '@core/services/LimitsEnvelope'
import { RefreshSetting } from '@core/stores/RefreshSetting'
import { WidgetRegistry } from '@core/stores/WidgetRegistry'
import { MetricPeriod } from '@core/support/MetricPeriod'
import { OpenUsageISO8601 } from '@core/support/OpenUsageISO8601'
import { addSeconds, type Instant } from '@core/support/time'
import { iso } from './TestSupport'

type JSONRecord = Record<string, unknown>

const fetchedAt = iso('2026-07-13T01:39:30.000Z')
const generatedAt = iso('2026-07-13T01:40:00.000Z')

const documentedExample = `
{
  "schema": "openusage.limits.v2",
  "generatedAt": "2026-07-13T01:40:00.000Z",
  "providers": {
    "codex": {
      "displayName": "ChatGPT · Work",
      "plan": "Pro 200",
      "fetchedAt": "2026-07-13T01:39:30.000Z",
      "expiresAt": "2026-07-13T01:49:30.000Z",
      "stale": false,
      "resources": {
        "session": {
          "kind": "consumption",
          "unit": "percent",
          "used": 42,
          "limit": 100,
          "remaining": 58,
          "utilization": 0.42,
          "resetsAt": "2026-07-13T06:00:00.000Z",
          "windowSeconds": 18000
        },
        "credits": {
          "kind": "balance",
          "unit": "credits",
          "available": 821
        }
      }
    }
  }
}
`

interface Input {
  registry: WidgetRegistry
  snapshots: Record<string, ProviderSnapshot>
  generatedAt: Instant
}

function json(text: string): JSONRecord {
  const value: unknown = JSON.parse(text)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('not a JSON object')
  return value as JSONRecord
}

function input(provider: Provider, snapshot: ProviderSnapshot, descriptors: WidgetDescriptor[]): Input {
  return { registry: new WidgetRegistry([provider], descriptors), snapshots: { [provider.id]: snapshot }, generatedAt }
}

function entryOf(root: JSONRecord, id: string): JSONRecord {
  const entry = (root.providers as JSONRecord | undefined)?.[id]
  if (!entry) throw new Error(`no entry for ${id}`)
  return entry as JSONRecord
}

function limitResource(key: string, provider: Provider, snapshot: ProviderSnapshot, descriptors: WidgetDescriptor[]): JSONRecord {
  const root = json(LimitsEnvelope.encode(input(provider, snapshot, descriptors)))
  const resource = (entryOf(root, provider.id).resources as JSONRecord | undefined)?.[key]
  if (!resource) throw new Error(`no resource ${key}`)
  return resource as JSONRecord
}

describe('LimitsEnvelopeTests', () => {
  it('testEnvelopeMatchesTheDocumentedExample', () => {
    const account = Account.make({ kind: 'codex', label: 'Work' })
    const snapshot = ProviderSnapshot.make({
      providerID: Account.cardID(account),
      displayName: 'ChatGPT',
      plan: 'Pro 200',
      lines: [
        MetricLine.progress('Session', 42, 100, ProgressFormat.percent, OpenUsageISO8601.date('2026-07-13T06:00:00.000Z'), 18_000_000),
        MetricLine.values('Credits', CodexUsageMapper.creditValues(821.6)),
        MetricLine.badge('Pay as you go', '2500 cap')
      ],
      refreshedAt: fetchedAt
    })
    const descriptors = widgetDescriptors(account)
    const provider = AccountProviderRuntime.provider(account)
    const request = input(provider, snapshot, descriptors)
    const actual = json(LimitsEnvelope.encode(request))
    const expected = json(documentedExample.replace('"codex": {', `"${Account.cardID(account)}": {`))

    expect(actual).toEqual(expected)

    request.generatedAt = addSeconds(fetchedAt, RefreshSetting.stalenessThreshold)
    const expired = json(LimitsEnvelope.encode(request))
    expect(entryOf(expired, Account.cardID(account)).stale).toBe(true)
  })

  it('testCardWithoutSnapshotHasNoEntryAndTheEnvelopeHasOnlyFilledKeys', () => {
    const pending = json(
      LimitsEnvelope.encode({
        registry: new WidgetRegistry([{ id: 'codex@ab12cd34', kind: 'codex' }], []),
        snapshots: {},
        generatedAt
      })
    )
    expect(pending.providers).toEqual({})
    expect(new Set(Object.keys(pending))).toEqual(new Set(['schema', 'generatedAt', 'providers']))
  })

  it('testProvidersPrintInTheRequestedOrderAndOnlyThoseRequested', () => {
    const providers: Provider[] = ['zai@2', 'zai@1'].map((id) => ({ id, kind: 'zai' }))
    const weekly = providers.map((provider) => WidgetDescriptor.percent({ key: 'weekly', provider, title: 'Weekly' }).exportingLimit('weekly', { unit: 'percent' }))
    const snapshot = (id: string): ProviderSnapshot =>
      ProviderSnapshot.make({
        providerID: id,
        displayName: 'Z.ai',
        lines: [MetricLine.progress('Weekly', 1, 100, ProgressFormat.percent)],
        refreshedAt: fetchedAt
      })
    const root = json(
      LimitsEnvelope.encode({
        registry: new WidgetRegistry(providers, weekly),
        snapshots: { 'zai@1': snapshot('zai@1'), 'zai@2': snapshot('zai@2'), 'zai@3': snapshot('zai@3') },
        generatedAt
      })
    )
    expect(new Set(Object.keys(root.providers as JSONRecord))).toEqual(new Set(['zai@1', 'zai@2']))
  })

  it('testFlexibleConsumptionExportsUncappedValueWithoutInventingLimit', () => {
    const provider: Provider = { id: 'claude', kind: 'claude' }
    const extra = WidgetDescriptor.boundedDollars({
      key: 'extra',
      provider,
      title: 'Extra Usage',
      metricLabel: 'Extra usage spent',
      limit: 100
    }).exportingLimit('extraUsage', { unit: 'usd', source: LimitResourceSource.progressOrValue('dollars') })
    const snapshot = ProviderSnapshot.make({
      providerID: 'claude',
      displayName: 'Claude',
      lines: [MetricLine.values('Extra usage spent', [metricValue(12.5, 'dollars')])],
      refreshedAt: fetchedAt
    })
    const resource = limitResource('extraUsage', provider, snapshot, [extra])

    expect(resource.used).toBe(12.5)
    expect(resource.unit).toBe('usd')
    expect(resource.limit).toBeUndefined()
    expect(resource.remaining).toBeUndefined()
    expect(resource.utilization).toBeUndefined()
  })

  it('testClaudeExtraUsageExportsItsBillingCurrencyAsTheUnit', () => {
    const provider: Provider = { id: 'claude', kind: 'claude' }
    const extra = WidgetDescriptor.boundedDollars({
      key: 'extra',
      provider,
      title: 'Extra Usage',
      metricLabel: 'Extra usage spent',
      limit: 100
    }).exportingLimit('extraUsage', { unit: 'usd', source: LimitResourceSource.progressOrValue('dollars') })
    const unit = (line: MetricLine): unknown => {
      const snapshot = ProviderSnapshot.make({ providerID: 'claude', displayName: 'Claude', lines: [line], refreshedAt: fetchedAt })
      return limitResource('extraUsage', provider, snapshot, [extra]).unit
    }

    expect(unit(MetricLine.progress('Extra usage spent', 12.34, 50, ProgressFormat.currency('EUR')))).toBe('eur')
    expect(unit(MetricLine.values('Extra usage spent', [metricValue(15, 'dollars', undefined, 'EUR')]))).toBe('eur')
  })

  it('testCopilotPremiumCreditsExportsPersonalCountAndPaidPercent', () => {
    const account = Account.make({ kind: 'copilot', label: 'Copilot' })
    const credits = widgetDescriptors(account).find((descriptor) => descriptor.id === `${Account.cardID(account)}.premium`)
    if (!credits) throw new Error('no premium descriptor')
    const personal = ProviderSnapshot.make({
      providerID: Account.cardID(account),
      displayName: 'Copilot',
      plan: 'Business',
      lines: [MetricLine.values('Credits', [metricValue(2111, 'count')])],
      refreshedAt: fetchedAt
    })
    const paid = ProviderSnapshot.make({
      providerID: Account.cardID(account),
      displayName: 'Copilot',
      plan: 'Pro',
      lines: [MetricLine.progress('Credits', 59, 100, ProgressFormat.percent)],
      refreshedAt: fetchedAt
    })

    const provider = AccountProviderRuntime.provider(account)
    const count = limitResource('premiumCredits', provider, personal, [credits])
    expect(count.used).toBe(2111)
    expect(count.unit).toBe('credits')
    expect(count.limit).toBeUndefined()

    const percent = limitResource('premiumCredits', provider, paid, [credits])
    expect(percent.used).toBe(59)
    expect(percent.unit).toBe('percent')
    expect(percent.limit).toBe(100)
  })

  it('testProgressResourceUnitFollowsRuntimeMetricFormat', () => {
    const provider: Provider = { id: 'cursor', kind: 'cursor' }
    const total = WidgetDescriptor.percent({ key: 'usage', provider, title: 'Total Usage', metricLabel: 'Total usage' }).exportingLimit('totalUsage', {
      unit: 'percent'
    })
    const snapshot = ProviderSnapshot.make({
      providerID: 'cursor',
      displayName: 'Cursor',
      lines: [MetricLine.progress('Total usage', 37, 750, ProgressFormat.count('requests'))],
      refreshedAt: fetchedAt
    })
    const resource = limitResource('totalUsage', provider, snapshot, [total])

    expect(resource.unit).toBe('requests')
    expect(resource.used).toBe(37)
    expect(resource.limit).toBe(750)
  })

  it('testAReportedZeroCodexBalanceIsExported', () => {
    const account = Account.make({ kind: 'codex', label: 'ChatGPT' })
    const provider = AccountProviderRuntime.provider(account)
    const usage = CodexUsageMapper.mapUsageResponse(new HTTPResponse(200, {}, '{"credits":{"balance":"0"}}'))
    const resource = limitResource(
      'credits',
      provider,
      ProviderSnapshot.forProvider(provider, usage.plan, usage.lines),
      widgetDescriptors(account)
    )
    expect(resource.available).toBe(0)
  })

  it('testResetExpiriesPrintSortedAsISO8601', () => {
    const account = Account.make({ kind: 'claude', label: 'Claude' })
    const descriptors = widgetDescriptors(account)
    const later = iso('2026-07-20T01:39:30.000Z')
    const sooner = iso('2026-07-14T01:39:30.000Z')
    const snapshot = ProviderSnapshot.make({
      providerID: Account.cardID(account),
      displayName: 'Claude',
      lines: [MetricLine.values('Rate Limit Resets', [metricValue(2, 'count', 'available')], [later, sooner])],
      refreshedAt: fetchedAt
    })
    const resource = limitResource('rateLimitResets', AccountProviderRuntime.provider(account), snapshot, descriptors)

    expect(resource.kind).toBe('balance')
    expect(resource.unit).toBe('resets')
    expect(resource.available).toBe(2)
    expect(resource.expiresAt).toEqual(['2026-07-14T01:39:30.000Z', '2026-07-20T01:39:30.000Z'])
  })

  it('testAntigravityArgonWeeklyExportsSeparatelyAndIsOmittedWhenAbsent', () => {
    const account = Account.make({ kind: 'antigravity', label: 'Antigravity' })
    const descriptors = widgetDescriptors(account)
    const reset = iso('2026-07-20T01:39:30.000Z')
    const snapshot = ProviderSnapshot.make({
      providerID: Account.cardID(account),
      displayName: 'Antigravity',
      plan: 'Pro',
      lines: [
        MetricLine.progress(AntigravityMetric.weeklyLabel, 10, 100, ProgressFormat.percent, undefined, MetricPeriod.weekMs),
        MetricLine.progress(AntigravityMetric.argonWeeklyLabel, 75, 100, ProgressFormat.percent, reset, MetricPeriod.weekMs)
      ],
      refreshedAt: fetchedAt
    })
    const provider = AccountProviderRuntime.provider(account)
    const argon = limitResource('argonWeekly', provider, snapshot, descriptors)
    const gemini = limitResource('geminiWeekly', provider, snapshot, descriptors)

    expect(argon.unit).toBe('percent')
    expect(argon.used).toBe(75)
    expect(argon.remaining).toBe(25)
    expect(argon.windowSeconds).toBe(604_800)
    expect(argon.resetsAt).toBe(OpenUsageISO8601.string(reset))
    expect(gemini.used).toBe(10)

    snapshot.lines = snapshot.lines.filter((line) => line.label !== AntigravityMetric.argonWeeklyLabel)
    const root = json(LimitsEnvelope.encode(input(provider, snapshot, descriptors)))
    const entry = entryOf(root, Account.cardID(account))
    expect(new Set(Object.keys(entry.resources as JSONRecord))).toEqual(new Set(['geminiWeekly']))
  })

  it('testEveryProviderKindDeclaresTheDocumentedResourceKeys', () => {
    const actual = Object.fromEntries(
      ProviderKind.allCases.map((kind) => {
        const descriptors = widgetDescriptors(Account.make({ kind, label: ProviderKind.displayName(kind) }))
        return [kind, new Set(descriptors.flatMap((descriptor) => descriptor.limitResources).map((resource) => resource.key))]
      })
    )
    const expected: Record<string, Set<string>> = {
      claude: new Set(['session', 'weekly', 'sonnet', 'fable', 'extraUsage', 'rateLimitResets']),
      codex: new Set(['session', 'weekly', 'spark', 'sparkWeekly', 'credits', 'rateLimitResets']),
      cursor: new Set(['totalUsage', 'grokBot', 'autoUsage', 'apiUsage', 'onDemand', 'requests', 'credits']),
      antigravity: new Set(['geminiSession', 'geminiWeekly', 'argonWeekly', 'nonGeminiSession', 'nonGeminiWeekly']),
      copilot: new Set(['premiumCredits', 'extraUsage', 'chat', 'completions']),
      devin: new Set(['daily', 'weekly', 'extraUsageBalance']),
      grok: new Set(['weekly']),
      muse: new Set(['session', 'weekly']),
      ollama: new Set(['session', 'weekly', 'monthly', 'purchasedCredits']),
      opencode: new Set(['session', 'weekly', 'monthly']),
      openrouter: new Set(['balance', 'keyLimit']),
      zai: new Set(['session', 'weekly', 'webSearches', 'rateLimitResets'])
    }

    expect(actual).toEqual(expected)
    const organization = widgetDescriptors(Account.make({ kind: 'copilot', label: 'acme', organization: 'acme' }))
    expect(new Set(organization.flatMap((descriptor) => descriptor.limitResources).map((resource) => resource.key))).toEqual(
      new Set(['orgCredits', 'orgSpend'])
    )
  })
})
