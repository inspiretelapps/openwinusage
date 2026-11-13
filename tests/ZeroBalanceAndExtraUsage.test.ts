import { describe, expect, it } from 'vitest'
import { Account, ProviderKind } from '@core/models/Account'
import type { MetricLine } from '@core/models/MetricLine'
import { ProviderSnapshot } from '@core/models/ProviderSnapshot'
import type { WidgetData } from '@core/models/WidgetData'
import { AccountProviderRuntime } from '@core/providers/AccountProviderRuntime'
import { widgetDescriptors } from '@core/providers/AccountProviderRuntime+Descriptors'
import { ClaudeUsageMapper } from '@core/providers/claude/ClaudeUsageMapper'
import { CopilotUsageMapper } from '@core/providers/copilot/CopilotUsageMapper'
import { CursorUsageMapper } from '@core/providers/cursor/CursorUsageMapper'
import { DevinUsageMapper } from '@core/providers/devin/DevinUsageMapper'
import { GrokUsageMapper } from '@core/providers/grok/GrokUsageMapper'
import { OllamaUsageMapper } from '@core/providers/ollama/OllamaUsageMapper'
import { OpenRouterUsageMapper } from '@core/providers/openrouter/OpenRouterUsageMapper'
import { ProviderParse, type JSONObject } from '@core/support/ProviderParse'
import { isolatedDefaults, jsonResponse, StubRuntime } from './TestSupport'
import { storeForTesting } from './support/dataStoreHelpers'

/** A balance shows at $0. Extra Usage shows while the provider has it on, even at $0, and hides while it is off. */
async function shownRow(kind: ProviderKind, lines: MetricLine[], key: string): Promise<WidgetData | undefined> {
  const account = Account.make({ kind, label: ProviderKind.displayName(kind) })
  const provider = AccountProviderRuntime.provider(account)
  const descriptors = widgetDescriptors(account)
  const runtime = StubRuntime.snapshot(provider, descriptors, ProviderSnapshot.forProvider(provider, undefined, lines))
  const store = storeForTesting([runtime], { defaults: isolatedDefaults() })
  await store.refreshAll()
  return store
    .accounts([{ provider, metrics: descriptors }])
    .flatMap((entry) => entry.lines)
    .find((line) => line.descriptor.key === key)?.data
}

function json(text: string): JSONObject {
  const object = ProviderParse.jsonObject(text)
  if (!object) throw new Error(`not a JSON object: ${text}`)
  return object
}

function cursorLines(extra: string, creditGrants?: string): MetricLine[] {
  const usage = json(`
        {"billingCycleEnd":"1764547200000","billingCycleStart":"1761955200000","enabled":true,
         "planUsage":{"apiPercentUsed":0,"autoPercentUsed":0,"limit":40000,"remaining":40000,"totalPercentUsed":0}${extra}}`)
  return CursorUsageMapper.mapUsage(usage, 'Pro', creditGrants === undefined ? undefined : json(creditGrants), 0).lines
}

describe('ZeroBalanceAndExtraUsageTests', () => {
  it('testClaudeExtraUsageHidesWhenOffAndShowsZeroSpentWhenOn', async () => {
    const lines = (extra: string): MetricLine[] =>
      ClaudeUsageMapper.mapUsageResponse(jsonResponse(`{"five_hour":{"utilization":10},"extra_usage":${extra}}`))
    const off = await shownRow('claude', lines('{"is_enabled":false,"monthly_limit":null,"used_credits":null}'), 'extra')
    expect(off).toBeUndefined()

    const on = await shownRow('claude', lines('{"is_enabled":true,"monthly_limit":null,"used_credits":0}'), 'extra')
    expect(on?.unboundedDetail).toBe('$0 spent')

    const capped = await shownRow('claude', lines('{"is_enabled":true,"monthly_limit":5000,"used_credits":0}'), 'extra')
    expect(capped?.limit).toBe(50)
    expect(capped?.used).toBe(0)
  })

  it('testCursorExtraUsageHidesWithNoLimitAndShowsAZeroBarWithOne', async () => {
    const off = await shownRow('cursor', cursorLines(',"spendLimitUsage":{"limitType":"user"}'), 'onDemand')
    expect(off).toBeUndefined()

    const on = await shownRow(
      'cursor',
      cursorLines(',"spendLimitUsage":{"individualLimit":5000,"individualRemaining":5000,"limitType":"user"}'),
      'onDemand'
    )
    expect(on?.limit).toBe(50)
    expect(on?.used).toBe(0)
  })

  it('testCopilotExtraUsageHidesWhenNotPermittedAndShowsZeroWhenPermitted', async () => {
    const lines = (permitted: boolean): MetricLine[] =>
      CopilotUsageMapper.mapBody(
        json(`
            {"copilot_plan":"individual","quota_reset_date":"2026-12-01","quota_snapshots":{"premium_interactions":
             {"entitlement":300,"remaining":300,"percent_remaining":100,"overage_permitted":${permitted},"overage_count":0}}}`)
      ).lines
    const off = await shownRow('copilot', lines(false), 'extra')
    expect(off).toBeUndefined()

    const on = await shownRow('copilot', lines(true), 'extra')
    expect(on?.unboundedDetail).toBe('0')
  })

  it('testGrokExtraUsageHidesWithNoPayAsYouGoCapAndShowsTheCap', async () => {
    const lines = (cap: string): MetricLine[] =>
      GrokUsageMapper.mapCreditsConfig(
        jsonResponse(`
            {"config":{"currentPeriod":{"type":"USAGE_PERIOD_TYPE_WEEKLY","start":"2026-06-30T21:36:52Z",
             "end":"2026-07-07T21:36:52Z"}${cap}}}`)
      ).lines
    const off = await shownRow('grok', lines(''), 'payAsYouGo')
    expect(off).toBeUndefined()

    const on = await shownRow('grok', lines(',"onDemandCap":{"val":2500}'), 'payAsYouGo')
    expect(on?.unboundedDetail).toBe('2500 cap')
  })

  it('testDevinExtraUsageShowsAReportedZeroBalanceAndHidesWhenWindsurfReportsNone', async () => {
    const lines = (balance: string): MetricLine[] =>
      DevinUsageMapper.map(`{"userStatus":{"planStatus":{"weeklyQuotaRemainingPercent":40${balance}}}}`).lines
    const reported = await shownRow('devin', lines(',"overageBalanceMicros":"0"'), 'extra')
    expect(reported?.unboundedDetail).toBe('$0 left')

    const none = await shownRow('devin', lines(''), 'extra')
    expect(none).toBeUndefined()
  })

  it('testBalancesShowAtZero', async () => {
    const openRouter = OpenRouterUsageMapper.creditsLines('{"data":{"total_credits":10,"total_usage":10}}')
    const balance = await shownRow('openrouter', openRouter, 'balance')
    expect(balance?.unboundedDetail).toBe('$0 left')

    const ollama = OllamaUsageMapper.balanceLines('{"included":{"balance_usd":100,"allowance_usd":100},"purchased":{"balance_usd":0}}')
    const purchased = await shownRow('ollama', ollama, 'purchasedCredits')
    expect(purchased?.unboundedDetail).toBe('$0 left')

    const cursor = await shownRow('cursor', cursorLines('', '{"hasCreditGrants":false}'), 'credits')
    expect(cursor?.unboundedDetail).toBe('$0 left')

    const unread = await shownRow('cursor', cursorLines(''), 'credits')
    expect(unread, 'a failed credit-grants read is not a $0 balance').toBeUndefined()
  })
})
