import { describe, expect, it } from 'vitest'
import { Account, AccountCredential, OAuthTokens } from '@core/models/Account'
import { ModelFigure, UsageBreakdown, type UsageBreakdownModel } from '@core/models/UsageHistory'
import type { WidgetDescriptor } from '@core/models/WidgetDescriptor'
import { AccountProviderRuntime } from '@core/providers/AccountProviderRuntime'
import type { ProviderRuntime } from '@core/providers/ProviderRuntime'
import { CodexUsageClient } from '@core/providers/codex/CodexUsageClient'
import { CodexUsageReports } from '@core/providers/codex/CodexUsageReports'
import { HTTPResponse, type HTTPRequest } from '@core/services/HTTPClient'
import { ProviderSnapshotCache } from '@core/stores/ProviderSnapshotCache'
import { WidgetDataStore } from '@core/stores/WidgetDataStore'
import { WidgetRegistry } from '@core/stores/WidgetRegistry'
import type { Defaults } from '@core/support/Defaults'
import { OpenUsageISO8601 } from '@core/support/OpenUsageISO8601'
import { addSeconds, type Clock } from '@core/support/time'
import { InMemoryCredentialVault, isolatedDefaults, RoutingHTTPClient, TestClock, TestSwitch, unix } from './TestSupport'

/** Shaped like ChatGPT's live answers for a Pro sign-in (recorded through a CLIProxyAPI hub, ids removed). */
export const CodexUsageFixtures = {
  usage(planType = 'pro', individualLimit = 'null'): string {
    return `
        {"plan_type":"${planType}","rate_limit":{"allowed":true,"limit_reached":false,
         "primary_window":{"limit_window_seconds":604800,"reset_after_seconds":481662,"reset_at":1793915535,"used_percent":29},
         "secondary_window":null},"additional_rate_limits":null,"code_review_rate_limit":null,
         "credits":{"approx_cloud_messages":[0,0],"approx_local_messages":[0,0],"balance":"0","has_credits":false,
          "overage_limit_reached":false,"unlimited":false},
         "spend_control":{"individual_limit":${individualLimit},"reached":false},"rate_limit_reached_type":null,"promo":null,
         "rate_limit_reset_credits":{"applicable_available_count":0,"available_count":0}}
        `
  },

  /** Only the active days are named, plus today's explicit zero once it has been reported. */
  counts(reportsToday = true): string {
    if (!reportsToday) return activeCounts
    const today = '{"date":"2026-10-31","clients":[],"totals":{"text_total_tokens":0,"turns":0}}'
    return activeCounts.replace('"data":[', '"data":[' + today + ',')
  },

  /**
   * Shaped like the Codex client's team fixture: plan usage in `credits`, charged credits in
   * `credit_usage_credits` and `on_demand_credits`, and no `units`.
   */
  workspaceBreakdown: `
    {"data":[
     {"date":"2026-10-29","premium_usage_values":{"credit_usage_credits":{"cli":3.0}},
      "models":[{"model":"gpt-6-astra","on_demand_credits":3.0}]},
     {"date":"2026-10-30","product_surface_usage_values":{"desktop_app":20.0},
      "premium_usage_values":{"credit_usage_credits":{"cli":4.0,"desktop_app":8.5},"total_usage_credits":{},
       "uncached_text_input_tokens_by_surface":{},"cached_text_input_tokens_by_surface":{},"text_output_tokens_by_surface":{},
       "text_total_tokens_by_surface":{}},
      "models":[{"credits":12.5,"model":"gpt-6-astra","speed":"fast","on_demand_credits":8.0},
       {"credits":2.5,"model":"gpt-6-astra","speed":"standard","on_demand_credits":2.0},
       {"credits":5.0,"model":"gpt-6.1-sol","speed":"standard","on_demand_credits":2.5}]}]}
    `,

  /** A report in relative units, as a personal plan's token report is. */
  relativeBreakdown: `
    {"units":"percent","group_by":"day","data":[{"date":"2026-10-30","product_surface_usage_values":{"desktop_app":100.0},
     "models":[{"credits":100.0,"model":"gpt-6-astra","speed":"fast"}]}]}
    `,

  enterpriseCredits: `
    {"breakdown":"model","unit":"credits","series":[{"key":"gpt-6-astra","label":"GPT-6 Astra","total":10.0},
     {"key":"gpt-6.1-sol","label":"GPT-6.1 Sol","total":2.5}],
     "data":[{"date":"2026-10-30","values":{"gpt-6-astra":10.0,"gpt-6.1-sol":2.5}}]}
    `
}

const activeCounts = `
    {"balance_unit":"credit","group_by":"day","data":[
     {"date":"2026-10-02","clients":[],"totals":{"cached_text_input_tokens":470000000,"credits":16259.4,"text_output_tokens":363029,
      "text_total_tokens":495363029,"threads":40,"turns":392,"uncached_text_input_tokens":25000000,"users":1}},
     {"date":"2026-10-29",
      "clients":[{"cached_text_input_tokens":471808,"client_id":"CODEX_CLI","credits":6.335318,"text_output_tokens":2238,
        "text_total_tokens":567638,"threads":0,"turns":0,"uncached_text_input_tokens":93592,"users":0},
       {"client_id":"CODEX_DESKTOP_APP","credits":0.0,"threads":51,"turns":71,"users":1}],
      "models":[{"credits":0.0,"model":"gpt-6.1-sol","threads":40,"turns":55,"users":1},
       {"credits":0.0,"model":"gpt-6-astra","threads":3,"turns":31,"users":1}],
      "totals":{"cached_text_input_tokens":1475954688,"credits":68877.04709850001,"text_output_tokens":2180573,
       "text_total_tokens":1511437552,"threads":60,"turns":86,"uncached_text_input_tokens":33302291,"users":1}},
     {"date":"2026-10-30","clients":[],"totals":{"cached_text_input_tokens":7183232,"credits":105.64575,"text_output_tokens":27164,
      "text_total_tokens":8139475,"threads":0,"turns":0,"uncached_text_input_tokens":929079,"users":0}}]}
    `

type Optional<Value> = TestSwitch<Value | undefined>

interface AccountOptions {
  planType?: string
  individualLimit?: string
  workspaceBreakdown?: string
  reports?: Optional<number>
  creditStatus?: Optional<number>
  reportsToday?: TestSwitch<boolean>
  clock?: TestClock
  defaults?: Defaults
}

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

const path = (request: HTTPRequest): string => new URL(request.url).pathname
const usagePath = new URL(CodexUsageClient.usageURL).pathname

describe('CodexUsageHistoryTests', () => {
  const now = unix(1_793_433_600 + 8 * 3600)

  function makeAccount(options: AccountOptions = {}): { store: WidgetDataStore; runtime: AccountProviderRuntime; http: RoutingHTTPClient; clock: TestClock } {
    const reports = options.reports ?? new TestSwitch<number | undefined>(undefined)
    const creditStatus = options.creditStatus ?? new TestSwitch<number | undefined>(undefined)
    const reportsToday = options.reportsToday ?? new TestSwitch(true)
    const workspaceBreakdown = options.workspaceBreakdown ?? CodexUsageFixtures.workspaceBreakdown
    const account = Account.make({ kind: 'codex', label: 'ChatGPT' })
    const vault = new InMemoryCredentialVault()
    vault.save(AccountCredential.oauth(OAuthTokens.make('access', 'refresh', undefined, { chatgpt_account_id: 'acct-fake' })), account.id)
    const clock = options.clock ?? new TestClock(now)
    const usage = CodexUsageFixtures.usage(options.planType, options.individualLimit)
    const http = new RoutingHTTPClient((request) => {
      let body: string
      switch (path(request)) {
        case usagePath:
          body = usage
          break
        case '/backend-api/wham/analytics/daily-workspace-usage-counts':
          body = CodexUsageFixtures.counts(reportsToday.value)
          break
        case '/backend-api/wham/usage/daily-workspace-user-token-usage-breakdown':
          body = workspaceBreakdown
          break
        case '/backend-api/wham/usage/daily-workspace-user-credit-usage':
          body = CodexUsageFixtures.enterpriseCredits
          break
        default:
          return new HTTPResponse(404)
      }
      if (path(request).startsWith('/backend-api/wham/usage/') && creditStatus.value !== undefined) {
        return new HTTPResponse(creditStatus.value, { 'retry-after': '3600' })
      }
      if (path(request) !== usagePath && reports.value !== undefined) {
        return new HTTPResponse(reports.value)
      }
      return new HTTPResponse(200, {}, body)
    })
    const runtime = new AccountProviderRuntime(account, vault, http, clock.now)
    return { store: storeForTesting([runtime], options.defaults ?? isolatedDefaults(), clock.now), runtime, http, clock }
  }

  function rows(store: WidgetDataStore, runtime: AccountProviderRuntime): Record<string, string> {
    const shown: Record<string, string> = {}
    for (const descriptor of runtime.widgetDescriptors) {
      if (descriptor.historyRow === undefined) continue
      const data = store.data(descriptor)
      if (data.hasData) shown[descriptor.key] = data.unboundedDetail
    }
    return shown
  }

  function reportRequests(http: RoutingHTTPClient): HTTPRequest[] {
    return http.requests.filter(
      (request) => path(request).startsWith('/backend-api/wham/usage/') || path(request).startsWith('/backend-api/wham/analytics/')
    )
  }

  function query(request: HTTPRequest): string[] {
    return [...new URL(request.url).searchParams].map(([name, value]) => `${name}=${value}`)
  }

  function descriptor(runtime: AccountProviderRuntime, key: string): WidgetDescriptor {
    const found = runtime.widgetDescriptors.find((candidate) => candidate.key === key)
    if (!found) throw new Error(`no ${key} descriptor`)
    return found
  }

  function requestsFor(http: RoutingHTTPClient, route: string): HTTPRequest | undefined {
    return reportRequests(http).find((request) => path(request).endsWith(route))
  }

  function breakdown(store: WidgetDataStore, runtime: AccountProviderRuntime, key: string): UsageBreakdown {
    const found = store.usageBreakdown(descriptor(runtime, key))
    if (!found) throw new Error(`no ${key} breakdown`)
    return found
  }

  /** `breakdown.models`: the models under the first figure they report. */
  function models(shown: UsageBreakdown): UsageBreakdownModel[] {
    const figure = UsageBreakdown.modelFigures(shown)[0]
    return figure === undefined ? [] : UsageBreakdown.models(shown, figure)
  }

  const shares = (shown: UsageBreakdown): string[] =>
    models(shown).flatMap((model) => (model.share === undefined ? [] : [ModelFigure.text('share', model.share)]))

  it('testAPersonalPlanShowsTheTokensOfEachUTCRangeAndNoDollars', async () => {
    const { store, runtime, http } = makeAccount()

    await store.refresh(runtime.provider.id, true)

    expect(store.errorMessage(runtime.provider.id)).toBeUndefined()
    expect(rows(store, runtime)).toEqual({ today: '0 tokens', yesterday: '8.1M tokens', last30: '2B tokens' })
    const requests = reportRequests(http)
    // personal plans only need counts for token totals and model turns
    expect(requests.map(path)).toEqual(['/backend-api/wham/analytics/daily-workspace-usage-counts'])
    const counts = requests.find((request) => path(request).endsWith('daily-workspace-usage-counts'))
    if (!counts) throw new Error('no counts request')
    expect(query(counts)).toEqual(['start_date=2026-10-02', 'end_date=2026-10-31', 'group_by=day', 'workspace_user=true'])
    expect(counts.headers?.['ChatGPT-Account-Id']).toBe('acct-fake')
    expect(counts.headers?.['Authorization']).toBe('Bearer access')
  })

  it('testAPersonalPlansModelSharesUseAllReportedTurnsEvenWhenOnlySomeAreAttributed', async () => {
    const { store, runtime } = makeAccount()

    await store.refresh(runtime.provider.id, true)

    const last30 = breakdown(store, runtime, 'last30')
    expect(last30.totals.values.credits).toBeUndefined()
    expect(last30.totals.values.turns).toBe(478)
    expect(last30.totals.values.tokens).toBe(2_014_940_056)
    expect(UsageBreakdown.tokenParts(last30).map((part) => part.title)).toEqual(['Cache Read', 'Input', 'Output'])
    expect(models(last30).map((model) => model.name)).toEqual(['gpt-6.1-sol', 'gpt-6-astra'])
    // 55 and 31 named turns out of the 478 reported across the sparse month
    expect(shares(last30)).toEqual(['12%', '6%'])
    const oct29 = OpenUsageISO8601.date('2026-10-29T00:00:00Z')
    if (oct29 === undefined) throw new Error('bad fixture date')
    const day = makeAccount({ clock: new TestClock(oct29) })
    await day.store.refresh(day.runtime.provider.id, true)
    const full = breakdown(day.store, day.runtime, 'today')
    expect(shares(full)).toEqual(['64%', '36%'])
  })

  it('testRelaunchImmediatelyShowsTheCachedHistoryDetailsWithoutARequest', async () => {
    const defaults = isolatedDefaults()
    const { store, runtime, http } = makeAccount({ planType: 'team', defaults })
    await store.refresh(runtime.provider.id, true)
    const snapshot = store.snapshots[runtime.provider.id]
    if (!snapshot) throw new Error('no snapshot')
    const fresh = addSeconds(snapshot.refreshedAt, 1)
    const newRuntime = new AccountProviderRuntime(runtime.account, runtime.vault, http, () => fresh)
    const reopened = storeForTesting([newRuntime], defaults, () => fresh)
    const requestCount = http.requests.length

    const outcome = await reopened.refresh(newRuntime.provider.id)
    expect(outcome).toBe('cacheHit')
    expect(http.requests.length).toBe(requestCount)
    for (const key of ['today', 'yesterday', 'last30']) {
      const row = descriptor(newRuntime, key)
      const detail = store.usageBreakdown(row)
      expect(detail).toBeDefined()
      expect(reopened.data(row).hasData).toBe(true)
      expect(reopened.usageBreakdown(row)).toEqual(detail)
    }
  })

  it('testATeamPlanShowsTheChargedCreditsOfTheWorkspaceReportAndRanksModelsByThem', async () => {
    const { store, runtime, http } = makeAccount({ planType: 'team' })

    await store.refresh(runtime.provider.id, true)

    expect(rows(store, runtime).yesterday).toBe('8.1M tokens')
    expect(rows(store, runtime).today).toBe('0 tokens')
    const report = requestsFor(http, 'daily-workspace-user-token-usage-breakdown')
    if (!report) throw new Error('no breakdown request')
    expect(query(report)).toEqual(['start_date=2026-10-02', 'end_date=2026-10-31', 'group_by=day'])
    const yesterday = breakdown(store, runtime, 'yesterday')
    // a workspace reports only credits per model
    expect(UsageBreakdown.modelFigures(yesterday)).toEqual(['share'])
    expect(models(yesterday).map((model) => model.name)).toEqual(['gpt-6-astra', 'gpt-6.1-sol'])
    expect(shares(yesterday)).toEqual(['80%', '20%'])
  })

  it('testAWorkspaceReportWithoutChargedCreditsShowsNoCredits', async () => {
    for (const workspaceBreakdown of [CodexUsageFixtures.relativeBreakdown, '{}']) {
      const { store, runtime } = makeAccount({ planType: 'team', workspaceBreakdown })

      await store.refresh(runtime.provider.id, true)

      expect(rows(store, runtime), workspaceBreakdown).toEqual({ today: '0 tokens', yesterday: '8.1M tokens', last30: '2B tokens' })
      const yesterday = store.usageBreakdown(descriptor(runtime, 'yesterday'))
      expect(yesterday === undefined ? undefined : models(yesterday), workspaceBreakdown).toEqual([])
      expect(yesterday?.totals.values.credits, workspaceBreakdown).toBeUndefined()
    }
  })

  it('testBusinessEducationAndEnterprisePlansReadTheirChargedCreditsByModel', async () => {
    for (const planType of ['business', 'edu', 'enterprise']) {
      const { store, runtime, http } = makeAccount({ planType })

      await store.refresh(runtime.provider.id, true)

      const credits = requestsFor(http, 'daily-workspace-user-credit-usage')
      if (!credits) throw new Error(`no credits request for ${planType}`)
      expect(query(credits), planType).toEqual(['start_date=2026-10-02', 'end_date=2026-10-31', 'breakdown=model'])
      expect(rows(store, runtime).yesterday, planType).toBe('8.1M tokens')
      const yesterday = breakdown(store, runtime, 'yesterday')
      expect(models(yesterday).map((model) => model.name), planType).toEqual(['gpt-6-astra', 'gpt-6.1-sol'])
    }
  })

  it('testADayTheCountsDoNotReportYetReadsZeroTokensWithNothingToShow', async () => {
    const reportsToday = new TestSwitch(false)
    const { store, runtime, clock } = makeAccount({ reportsToday })

    await store.refresh(runtime.provider.id, true)
    // a day with no use still shows Today, and the range sums the days that report
    expect(rows(store, runtime)).toEqual({ today: '0 tokens', yesterday: '8.1M tokens', last30: '2B tokens' })
    expect(UsageBreakdown.isEmpty(breakdown(store, runtime, 'today'))).toBe(true)

    reportsToday.value = true
    clock.set(addSeconds(now, 61 * 60))
    await store.refresh(runtime.provider.id, true)
    expect(rows(store, runtime).today).toBe('0 tokens')
  })

  it('testHistoryIsReadOnceAnHourAtOnceOnANewUTCDayAndOnAForcedReread', async () => {
    const { store, runtime, http, clock } = makeAccount()
    await store.refresh(runtime.provider.id, true)
    expect(reportRequests(http).length).toBe(1)

    clock.set(addSeconds(now, 30 * 60))
    await store.refresh(runtime.provider.id, true)
    // an hour has not passed
    expect(reportRequests(http).length).toBe(1)
    // the rows keep the last read
    expect(rows(store, runtime).yesterday).toBe('8.1M tokens')

    clock.set(addSeconds(now, 61 * 60))
    await store.refresh(runtime.provider.id, true)
    expect(reportRequests(http).length).toBe(2)

    clock.set(addSeconds(now, 62 * 60))
    await store.refresh(runtime.provider.id, true, true)
    // a forced reread reads at once
    expect(reportRequests(http).length).toBe(3)

    clock.set(unix(1_793_491_500))
    await store.refresh(runtime.provider.id, true)
    // a new UTC day is read on the first refresh after midnight
    expect(reportRequests(http).length).toBe(4)
    const counts = reportRequests(http).findLast((request) => path(request).endsWith('daily-workspace-usage-counts'))
    if (!counts) throw new Error('no counts request')
    // today, and yesterday, which was read before it ended
    expect(query(counts).slice(0, 2)).toEqual(['start_date=2026-10-31', 'end_date=2026-11-01'])
  })

  it('testFailedCountsKeepTheCardAndSumOnlyPreviouslyReadDays', async () => {
    const reports = new TestSwitch<number | undefined>(500)
    const { store, runtime, http, clock } = makeAccount({ reports })

    await store.refresh(runtime.provider.id, true)
    expect(store.errorMessage(runtime.provider.id)).toBeUndefined()
    expect(rows(store, runtime)).toEqual({ today: '0 tokens', yesterday: '0 tokens', last30: '0 tokens' })
    expect(store.data(descriptor(runtime, 'weekly')).used).toBe(29)

    reports.value = undefined
    clock.set(addSeconds(now, 10 * 60))
    await store.refresh(runtime.provider.id, true)
    // a failed read waits an hour
    expect(reportRequests(http).length).toBe(1)

    clock.set(addSeconds(now, 61 * 60))
    await store.refresh(runtime.provider.id, true)
    const month = descriptor(runtime, 'last30')
    expect(store.usageBreakdown(month)?.totals.values.tokens).toBe(2_014_940_056)

    reports.value = 503
    clock.set(addSeconds(now, 122 * 60))
    await store.refresh(runtime.provider.id, true)
    expect(rows(store, runtime).today).toBe('0 tokens')
    expect(rows(store, runtime).yesterday).toBe('0 tokens')
    // Oct 2 and Oct 29 remain available after the reread of today and yesterday fails
    expect(store.usageBreakdown(month)?.totals.values.tokens).toBe(2_006_800_581)
  })

  it('testMissingWorkspaceCreditsDoNotHideOrBlockTokenCounts', async () => {
    const status = new TestSwitch<number | undefined>(429)
    const { store, runtime, http, clock } = makeAccount({ planType: 'team', creditStatus: status })
    const month = descriptor(runtime, 'last30')
    await store.refresh(runtime.provider.id, true)
    expect(store.usageBreakdown(month)).toBeDefined()

    status.value = undefined
    clock.set(addSeconds(now, 30 * 60))
    await store.refresh(runtime.provider.id, true, true)
    expect(reportRequests(http).filter((request) => path(request).endsWith('usage-counts')).length).toBe(2)
    expect(reportRequests(http).filter((request) => path(request).endsWith('token-usage-breakdown')).length).toBe(1)
    expect(rows(store, runtime).last30).toBe('2B tokens')

    clock.set(addSeconds(now, 61 * 60))
    await store.refresh(runtime.provider.id, true)
    const full = store.usageBreakdown(month)
    if (!full) throw new Error('no breakdown')
    expect(full.totals.values.credits).toBe(15.5)

    status.value = 503
    clock.set(addSeconds(now, 122 * 60))
    await store.refresh(runtime.provider.id, true)
    expect(rows(store, runtime)).toEqual({ today: '0 tokens', yesterday: '8.1M tokens', last30: '2B tokens' })
    const partial = store.usageBreakdown(month)
    if (!partial) throw new Error('no breakdown')
    expect(partial.totals.values.tokens).toBe(full.totals.values.tokens)
    // only Oct 29's charge remains after the credit reread fails
    expect(partial.totals.values.credits).toBe(3)
  })

  it('testTheCreditLimitShowsWhatTheWorkspaceLetsTheMemberSpend', async () => {
    const limit =
      '{"source":"workspace_spend_controls","limit":"25000","used":"8000","remaining":"17000","used_percent":32,"remaining_percent":68,"reset_after_seconds":86400,"reset_at":1793520000}'
    const { store, runtime } = makeAccount({ planType: 'team', individualLimit: limit })

    await store.refresh(runtime.provider.id, true)

    const data = store.data(descriptor(runtime, 'creditLimit'))
    expect(data.used).toBe(8_000)
    expect(data.limit).toBe(25_000)
    expect(data.resetsAt).toBe(unix(1_793_520_000))

    const unlimited = makeAccount()
    await unlimited.store.refresh(unlimited.runtime.provider.id, true)
    // a Pro plan has no credit limit
    expect(unlimited.store.data(descriptor(unlimited.runtime, 'creditLimit')).hasData).toBe(false)
  })
})

describe('CodexUsageReportsTests', () => {
  it('testAMalformedDayRejectsTheWholeReport', () => {
    for (const body of [
      '{"data":{}}',
      '{"data":[{"date":"2026-10-30"}]}',
      '{"data":[{"date":"2026-10-30","totals":{"turns":-1}}]}',
      '{"data":[{"date":"2026-10-30","totals":{"turns":3,"text_total_tokens":"lots"}}]}',
      '{"data":[{"totals":{"turns":3}}]}'
    ]) {
      expect(CodexUsageReports.counts(body), body).toBeUndefined()
    }
    expect(
      CodexUsageReports.workspaceCredits('{"data":[{"date":"2026-10-30","premium_usage_values":{"credit_usage_credits":{"cli":"lots"}}}]}')
    ).toBeUndefined()
    expect(CodexUsageReports.enterpriseCredits('{"data":[{"date":"2026-10-30","values":{"a":"lots"}}]}')).toBeUndefined()
  })

  it('testRecordsForOneDateAddUpAndADateTheCountsLeaveOutHasNoTurns', () => {
    const counts = CodexUsageReports.counts(`
        {"data":[{"date":"2026-10-30","totals":{"turns":10,"text_total_tokens":100}},
                 {"date":"2026-10-30","totals":{"turns":10,"text_total_tokens":100}},
                 {"date":"2026-10-29","totals":{"turns":3,"text_total_tokens":null}}]}
        `)
    if (!counts) throw new Error('the counts did not parse')
    expect(counts.days.get('2026-10-30')?.totals.values).toEqual({ turns: 20, tokens: 200 })
    expect(counts.days.get('2026-10-29')?.totals.values).toEqual({ turns: 3 })
    expect(counts.quietDay.totals.values).toEqual({})
  })

  it('testAModelWithoutChargedCreditsLeavesTheOtherModelsAndDayTotalIntact', () => {
    const report = CodexUsageReports.workspaceCredits(`
        {"data":[{"date":"2026-10-30","premium_usage_values":{"credit_usage_credits":{"cli":2.5,"desktop_app":10}},
                  "models":[{"model":"a","credits":9,"on_demand_credits":2},{"model":"b","credits":9}]}]}
        `)
    if (!report) throw new Error('the report did not parse')

    expect(report.days.get('2026-10-30')?.totals.values).toEqual({ credits: 12.5 })
    expect(report.days.get('2026-10-30')?.byModel).toEqual({ a: { values: { credits: 2 } } })
  })
})
