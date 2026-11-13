import type { AccountCredential } from '../../models/Account'
import type { UsageHistory } from '../../models/UsageHistory'
import type { HTTPResponse } from '../../services/HTTPClient'
import { AppLog, describeError, LogTags } from '../../support/AppLog'
import { asObject, asString, nilIfEmpty, ProviderParse, type JSONObject } from '../../support/ProviderParse'
import type { AccountProviderRuntime } from '../AccountProviderRuntime'
import { ProviderError } from '../ProviderError'
import type { ProviderUsage } from '../ProviderRuntime'
import { refreshHistory } from '../UsageLedger'
import { cursorTokens, refreshCursorTokens } from './AccountProviderRuntime+CursorAuth'
import { CursorHistorySource } from './CursorHistorySource'
import { CursorUsageClient } from './CursorUsageClient'
import { CursorPlanUsageFacts, CursorUsageMapper } from './CursorUsageMapper'
import { CursorUsageSummaryMapper } from './CursorUsageSummaryMapper'

export async function refreshCursor(rt: AccountProviderRuntime, credential: AccountCredential): Promise<ProviderUsage> {
  let tokens = await cursorTokens(rt, credential)
  const client = new CursorUsageClient(rt.http)
  let usageResponse = await client.fetchUsage(tokens.accessToken)
  if (ProviderError.isAuthFailure(usageResponse)) {
    tokens = await refreshCursorTokens(rt, tokens)
    usageResponse = await client.fetchUsage(tokens.accessToken)
  }
  const usage = ProviderError.requireSuccessJSON(usageResponse, 'cursor')
  return cursorUsage(rt, usage, client, tokens.accessToken)
}

export async function cursorUsage(
  rt: AccountProviderRuntime,
  usage: JSONObject,
  client: CursorUsageClient,
  accessToken: string
): Promise<ProviderUsage> {
  const historySource = new CursorHistorySource(client, accessToken, rt.cardID)
  // `async let`: the history is read while the rest of the card is, and a failure of the rest cancels it.
  const history: Promise<UsageHistory | undefined> = refreshHistory(rt, historySource).catch(() => undefined)
  try {
    const mapped = await cursorLines(rt, usage, client, accessToken)
    const read = await history
    if (read === undefined) delete mapped.history
    else mapped.history = read
    return mapped
  } catch (error) {
    historySource.cancel()
    await history
    throw error
  }
}

async function cursorLines(rt: AccountProviderRuntime, usage: JSONObject, client: CursorUsageClient, accessToken: string): Promise<ProviderUsage> {
  let summary: JSONObject | undefined
  let summaryWasRead = false
  const readSummary = async (): Promise<JSONObject | undefined> => {
    if (!summaryWasRead) {
      summaryWasRead = true
      summary = await optionalJSON(rt, 'usage-summary', () => client.fetchUsageSummary(accessToken))
    }
    return summary
  }

  if (rt.planRead.isDue(rt.now())) {
    const planName = asString(asObject((await optionalJSON(rt, 'plan', () => client.fetchPlan(accessToken)))?.planInfo)?.planName)
    const fresh = planName === undefined ? undefined : nilIfEmpty(planName.trim())
    rt.planRead.record(fresh, rt.now())
  }
  if (rt.cursorMembershipRead.isDue(rt.now())) {
    const membership = CursorUsageMapper.membershipType(await readSummary())
    rt.cursorMembershipRead.record(membership, rt.now())
  }
  const planName = rt.planRead.value
  const membership = rt.cursorMembershipRead.value
  const isOrgSeat = membership === undefined ? false : CursorUsageMapper.orgMembershipTypes.has(membership)
  const displayPlanName = CursorUsageMapper.resolvedPlanName(planName, membership)
  const facts = new CursorPlanUsageFacts(usage)
  const fallback = CursorUsageMapper.shouldUseRequestBasedFallback(facts, isOrgSeat ? membership : planName)

  let mapped: ProviderUsage
  if (fallback.shouldFallback) {
    const summaryBody = await readSummary()
    const requestUsage = await optionalJSON(rt, 'request-based usage', () => client.fetchRequestBasedUsage(accessToken))
    mapped = CursorUsageSummaryMapper.map(summaryBody, requestUsage, displayPlanName, fallback.message)
  } else {
    let requestBased: ProviderUsage | undefined
    if (facts.shouldTryGenericRequestFallback) {
      const requestUsage = await optionalJSON(rt, 'request-based usage', () => client.fetchRequestBasedUsage(accessToken))
      if (requestUsage) {
        try {
          requestBased = CursorUsageSummaryMapper.map(undefined, requestUsage, displayPlanName, '')
        } catch {
          requestBased = undefined
        }
      }
    }
    if (requestBased) {
      mapped = requestBased
    } else {
      const stripe = await optionalJSON(rt, 'prepaid-balance', () => client.fetchStripeBalance(accessToken))
      const creditGrants = await optionalJSON(rt, 'credit-grants', () => client.fetchCredits(accessToken))
      mapped = CursorUsageMapper.mapUsage(usage, planName, creditGrants, CursorUsageMapper.stripeBalanceCents(stripe))
      setPlan(mapped, CursorUsageMapper.resolvedPlanLabel(planName, membership))
      const needsOnDemand = !mapped.lines.some((line) => line.label === 'On-demand')
      if (isOrgSeat ? needsOnDemand : facts.isTeamByShape) {
        const summary = await readSummary()
        if (summary && CursorUsageSummaryMapper.hasUsableSummaryPayload(summary)) {
          CursorUsageSummaryMapper.appendMissingOnDemand(summary, mapped.lines)
          setPlan(mapped, CursorUsageMapper.resolvedPlanLabel(planName, CursorUsageMapper.membershipType(summary) ?? membership) ?? mapped.plan)
        }
      }
    }
  }

  const grokBot = await optionalJSON(rt, 'Grok Bot usage', () => client.fetchGrokBotUsage(accessToken))
  if (grokBot) {
    const line = CursorUsageMapper.mapGrokBotUsage(grokBot)
    if (line) mapped.lines.push(line)
  }
  return mapped
}

function setPlan(usage: ProviderUsage, plan: string | undefined): void {
  if (plan === undefined) delete usage.plan
  else usage.plan = plan
}

async function optionalJSON(
  rt: AccountProviderRuntime,
  label: string,
  request: () => Promise<HTTPResponse | undefined>
): Promise<JSONObject | undefined> {
  const tag = LogTags.plugin('cursor')
  let response: HTTPResponse | undefined
  try {
    response = await request()
  } catch (error) {
    AppLog.warn(tag, `${rt.cardID} optional ${label} request failed: ${describeError(error)}`)
    return undefined
  }
  if (!response) {
    AppLog.warn(tag, `${rt.cardID} optional ${label} request could not be prepared from the current session`)
    return undefined
  }
  if (!(response.statusCode >= 200 && response.statusCode < 300)) {
    AppLog.warn(tag, `${rt.cardID} optional ${label} request returned HTTP ${response.statusCode}`)
    return undefined
  }
  const body = ProviderParse.jsonObject(response.body)
  if (!body) {
    AppLog.warn(tag, `${rt.cardID} optional ${label} response was not a JSON object`)
    return undefined
  }
  return body
}
