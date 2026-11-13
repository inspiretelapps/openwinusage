import { describe, expect, it } from 'vitest'
import { Account, AccountCredential, OAuthTokens } from '@core/models/Account'
import type { WidgetData } from '@core/models/WidgetData'
import { AccountProviderRuntime } from '@core/providers/AccountProviderRuntime'
import type { ProviderRuntime } from '@core/providers/ProviderRuntime'
import { CursorUsageClient } from '@core/providers/cursor/CursorUsageClient'
import { CursorUsageMapper } from '@core/providers/cursor/CursorUsageMapper'
import { HTTPResponse } from '@core/services/HTTPClient'
import { ProviderSnapshotCache } from '@core/stores/ProviderSnapshotCache'
import { WidgetDataStore } from '@core/stores/WidgetDataStore'
import { WidgetRegistry } from '@core/stores/WidgetRegistry'
import type { Defaults } from '@core/support/Defaults'
import { OpenUsageISO8601 } from '@core/support/OpenUsageISO8601'
import { InMemoryCredentialVault, isolatedDefaults, RoutingHTTPClient } from './TestSupport'

/** A JWT whose subject carries the user id the cursor.com cookie endpoints need. */
const accessToken = 'e30.' + Buffer.from('{"sub":"auth0|user_fake"}', 'utf8').toString('base64').replaceAll('=', '') + '.sig'

const individualUsage = `{"autoBucketModels":["fake-model"],"autoModelSelectedDisplayMessage":"fake","billingCycleEnd":"1764547200000",
 "billingCycleStart":"1761955200000","displayMessage":"fake","displayThreshold":50,"enabled":true,
 "namedModelSelectedDisplayMessage":"fake",
 "planUsage":{"apiPercentUsed":40,"autoPercentUsed":20,"bonusTooltip":"fake","limit":40000,"remaining":30000,
              "remainingBonus":false,"totalPercentUsed":25},
 "spendLimitUsage":{"individualLimit":50000,"individualRemaining":38000,"limitType":"user"}}`

const planInfo = '{"planInfo":{"billingCycleEnd":"1764547200000","includedUsagePeriod":"fake","planName":"Ultra","planOwner":"fake","price":"fake"}}'

const stripe = `{"customerBalance":-2500,"individualMembershipType":"ultra","isOnBillableAuto":false,"isOnStudentPlan":false,
 "isTeamMember":false,"isYearlyPlan":false,"lastPaymentFailed":false,"membershipType":"ultra","paymentId":"fake",
 "studentDiscountApplied":false,"subscriptionStatus":"active","trialEligible":false,"trialLengthDays":0,
 "trialWasCancelled":false,"verifiedStudent":false}`

const creditGrants = '{"hasCreditGrants":true,"totalCents":10000,"usedCents":4000}'

const grokBot = `{"billingBrand":"fake","currentPeriodStart":"2026-10-20T00:00:00Z","cursorPlanName":"fake","grokPlanLabel":"fake",
 "hasAvailableUsage":true,"hasNonZeroIncludedLimit":true,"nextResetTimestampUtc":"2026-10-27T00:00:00Z",
 "unifiedPlanMigration":{"href":"fake"},"upgradeRecommendations":[],"usagePercent":30}`

const enterpriseUsage = '{"billingCycleEnd":"1764547200000","billingCycleStart":"1761955200000","enabled":true,"planUsage":{}}'
const requestUsage = '{"gpt-4":{"numRequests":120,"maxRequestUsage":500},"startOfMonth":"2026-10-01T00:00:00Z"}'
const enterpriseSummary = `{"billingCycleStart":"2026-10-01T00:00:00Z","billingCycleEnd":"2026-11-01T00:00:00Z","membershipType":"enterprise",
 "individualUsage":{"onDemand":{"enabled":true,"used":2500,"limit":10000}}}`
const enterprisePoolUsage = `{"billingCycleEnd":"1764547200000","billingCycleStart":"1761955200000","enabled":true,
 "planUsage":{"apiPercentUsed":100,"autoPercentUsed":75,"limit":2000,"totalSpend":1500,"totalPercentUsed":76}}`
const personalSummary = '{"billingCycleStart":"2026-10-01T00:00:00Z","billingCycleEnd":"2026-11-01T00:00:00Z","membershipType":"pro"}'

const teamUsage = `{"billingCycleEnd":"1764547200000","billingCycleStart":"1761955200000","enabled":true,
 "planUsage":{"apiPercentUsed":10,"autoPercentUsed":5,"limit":2000,"totalSpend":300,"totalPercentUsed":7},
 "spendLimitUsage":{"limitType":"team"}}`
const teamSummary = `{"billingCycleStart":"2026-10-01T00:00:00Z","billingCycleEnd":"2026-11-01T00:00:00Z","membershipType":"team",
 "individualUsage":{"onDemand":{"enabled":true,"used":1500,"limit":20000}}}`

const pathOf = (url: string): string => new URL(url).pathname

/** `WidgetDataStore.forTesting(_:defaults:)` */
function storeForTesting(runtimes: ProviderRuntime[], defaults: Defaults): WidgetDataStore {
  return new WidgetDataStore({
    registry: WidgetRegistry.from(runtimes),
    providers: runtimes,
    cache: new ProviderSnapshotCache(defaults, 'snapshots'),
    defaults
  })
}

const noHTTP = (): RoutingHTTPClient => new RoutingHTTPClient(() => new HTTPResponse(404, {}, new Uint8Array()))

async function refresh(
  usage: string,
  planName: string,
  options: { summary?: string; requests?: string; events?: string } = {}
): Promise<{ plan: string | undefined; data: Record<string, WidgetData>; paths: string[] }> {
  const account = Account.make({ kind: 'cursor', label: 'Cursor' })
  const vault = new InMemoryCredentialVault()
  vault.save(AccountCredential.oauth(OAuthTokens.make(accessToken, 'refresh')), account.id)
  const plan = planInfo.replaceAll('Ultra', planName)
  const http = new RoutingHTTPClient((request) => {
    let body: string | undefined
    switch (pathOf(request.url)) {
      case pathOf(CursorUsageClient.usageURL):
        body = usage
        break
      case pathOf(CursorUsageClient.planURL):
        body = plan
        break
      case pathOf(CursorUsageClient.creditsURL):
        body = creditGrants
        break
      case pathOf(CursorUsageClient.stripeURL):
        body = stripe
        break
      case pathOf(CursorUsageClient.grokBotUsageURL):
        body = grokBot
        break
      case pathOf(CursorUsageClient.usageSummaryURL):
        body = options.summary
        break
      case pathOf(CursorUsageClient.restUsageURL):
        body = options.requests
        break
      case pathOf(CursorUsageClient.usageEventsURL):
        body = options.events
        break
      default:
        body = undefined
    }
    if (body === undefined) return new HTTPResponse(404, {}, new Uint8Array())
    return new HTTPResponse(200, {}, body)
  })
  const runtime = new AccountProviderRuntime(account, vault, http)
  const defaults = isolatedDefaults()
  const store = storeForTesting([runtime], defaults)
  await store.refresh(runtime.provider.id, true)
  expect(store.errorMessage(runtime.provider.id)).toBeUndefined()
  const data: Record<string, WidgetData> = {}
  for (const descriptor of runtime.widgetDescriptors) {
    const widget = store.data(descriptor)
    if (widget.hasData) data[widget.title] = widget
  }
  return { plan: store.plan(runtime.provider.id), data, paths: http.requests.map((request) => pathOf(request.url)) }
}

const keys = (data: Record<string, WidgetData>): Set<string> => new Set(Object.keys(data))

describe('CursorMetricsTests', () => {
  it('testTheCardHasEveryOriginalMetricTitle', () => {
    const account = Account.make({ kind: 'cursor', label: 'Cursor' })
    const runtime = new AccountProviderRuntime(account, new InMemoryCredentialVault(), noHTTP())
    expect(runtime.widgetDescriptors.map((descriptor) => descriptor.sample.title)).toEqual([
      'Total Usage',
      'Cursor Models',
      'Other Models',
      'Extra Usage',
      'Grok Bot',
      'Requests',
      'Credits',
      'Today',
      'Yesterday',
      'Last 30 Days'
    ])
  })

  it('testAnIndividualSeatShowsUsagePoolsExtraUsageGrokBotAndCredits', async () => {
    const { plan, data, paths } = await refresh(individualUsage, 'Ultra')

    expect(plan).toBe('Ultra')
    expect(keys(data)).toEqual(
      new Set(['Total Usage', 'Cursor Models', 'Other Models', 'Extra Usage', 'Grok Bot', 'Credits', 'Today', 'Yesterday', 'Last 30 Days'])
    )
    expect(data['Total Usage']?.used).toBe(25)
    expect(data['Cursor Models']?.used).toBe(20)
    expect(data['Other Models']?.used).toBe(40)
    expect(data['Extra Usage']?.kind).toBe('dollars')
    expect(data['Extra Usage']?.used).toBe(120)
    expect(data['Extra Usage']?.limit).toBe(500)
    expect(data['Extra Usage']?.resetsAt).toBeDefined()
    // Extra Usage resets with the billing cycle
    expect(data['Extra Usage']?.resetsAt).toBe(data['Total Usage']?.resetsAt)
    expect(data['Grok Bot']?.used).toBe(30)
    expect(data['Grok Bot']?.resetsAt).toBe(OpenUsageISO8601.date('2026-10-27T00:00:00Z'))
    expect(data['Credits']?.limit).toBeUndefined()
    // grants $100 - $40 used + $25 prepaid
    expect(data['Credits']?.values[0]?.number).toBe(85)
    // only the hourly membership read
    expect(paths.filter((path) => path === pathOf(CursorUsageClient.usageSummaryURL)).length).toBe(1)
    expect(paths.includes(pathOf(CursorUsageClient.restUsageURL))).toBe(false)
  })

  it('testARequestBasedEnterpriseSeatShowsRequestsAndExtraUsageFromTheRestEndpoints', async () => {
    for (const planName of ['Enterprise', 'Pro']) {
      const { plan, data } = await refresh(enterpriseUsage, planName, { summary: enterpriseSummary, requests: requestUsage })

      expect(plan, `GetPlanInfo says ${planName}`).toBe('Enterprise')
      expect(keys(data), planName).toEqual(new Set(['Total Usage', 'Requests', 'Extra Usage', 'Grok Bot', 'Today', 'Yesterday', 'Last 30 Days']))
      expect(data['Requests']?.kind).toBe('count')
      expect(data['Requests']?.used).toBe(120)
      expect(data['Requests']?.limit).toBe(500)
      expect(data['Total Usage']?.used).toBe(120)
      expect(data['Extra Usage']?.used, planName).toBe(25)
      expect(data['Extra Usage']?.limit, planName).toBe(100)
    }
  })

  it('testAPersonalSeatOnTheGenericRequestFallbackShowsItsRequestsAsTotalUsage', async () => {
    const { plan, data } = await refresh(enterpriseUsage, 'Pro', { summary: personalSummary, requests: requestUsage })

    expect(plan).toBe('Pro')
    expect(data['Requests']?.used).toBe(120)
    expect(data['Total Usage']?.used).toBe(120)
    expect(data['Total Usage']?.limit).toBe(500)
  })

  it('testAProReportedEnterpriseSeatShowsEnterpriseAndTakesExtraUsageFromUsageSummary', async () => {
    const { plan, data } = await refresh(enterprisePoolUsage, 'Pro', { summary: enterpriseSummary })

    // GetPlanInfo still says Pro for this Enterprise seat
    expect(plan).toBe('Enterprise')
    expect(data['Total Usage']?.used).toBe(76)
    expect(data['Cursor Models']?.used).toBe(75)
    expect(data['Other Models']?.used).toBe(100)
    expect(data['Extra Usage']?.used).toBe(25)
    expect(data['Extra Usage']?.limit).toBe(100)
  })

  it('testATeamMembershipRelabelsAProSeatWithoutChangingItsTotalUsage', async () => {
    for (const planUsage of [
      '{"limit":2000,"totalSpend":400,"totalPercentUsed":20}',
      '{"totalPercentUsed":20}',
      '{"totalPercentUsed":20,"autoPercentUsed":10,"apiPercentUsed":30}',
      '{"limit":2000,"totalSpend":400,"autoPercentUsed":10,"apiPercentUsed":30}'
    ]) {
      const { plan, data } = await refresh(`{"enabled":true,"planUsage":${planUsage}}`, ' Pro ', { summary: teamSummary })

      expect(plan, planUsage).toBe('Team')
      expect(data['Total Usage']?.kind, planUsage).toBe('percent')
      expect(data['Total Usage']?.used, planUsage).toBe(20)
    }
  })

  it('testOnlyAMissingOrProPlanNameGivesWayToAnOrgMembership', () => {
    for (const plan of ['Ultra', 'Business', 'Enterprise', 'Pro Plus']) {
      expect(CursorUsageMapper.resolvedPlanLabel(plan, 'team')).toBe(plan)
    }
    for (const plan of [undefined, '', '  ', 'Pro', ' pro plan ']) {
      expect(CursorUsageMapper.resolvedPlanLabel(plan, 'enterprise')).toBe('Enterprise')
    }
    expect(CursorUsageMapper.resolvedPlanLabel('Ultra', 'pro')).toBe('Ultra')
  })

  it('testATeamSeatTakesExtraUsageAndMembershipFromUsageSummary', async () => {
    const { plan, data } = await refresh(teamUsage, 'Pro', { summary: teamSummary })

    // GetPlanInfo still says Pro for team seats
    expect(plan).toBe('Team')
    expect(data['Total Usage']?.used).toBe(7)
    expect(data['Extra Usage']?.used).toBe(15)
    expect(data['Extra Usage']?.limit).toBe(200)
  })

  it('testTheTwoAccountShapesTogetherFillEveryCursorMetric', async () => {
    const individual = await refresh(individualUsage, 'Ultra', { events: '{"totalUsageEventsCount":0}' })
    const enterprise = await refresh(enterpriseUsage, 'Enterprise', { summary: enterpriseSummary, requests: requestUsage })
    const runtime = new AccountProviderRuntime(Account.make({ kind: 'cursor', label: 'Cursor' }), new InMemoryCredentialVault(), noHTTP())
    expect(new Set([...keys(individual.data), ...keys(enterprise.data)])).toEqual(
      new Set(runtime.widgetDescriptors.map((descriptor) => descriptor.sample.title))
    )
  })
})
