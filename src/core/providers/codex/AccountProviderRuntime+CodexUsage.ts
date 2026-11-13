import type { AccountCredential } from '../../models/Account'
import { CodexLogin } from '../../services/BrowserProviderLogins'
import { asString, ProviderParse } from '../../support/ProviderParse'
import type { AccountProviderRuntime } from '../AccountProviderRuntime'
import type { ProviderUsage } from '../ProviderRuntime'
import { refreshHistory } from '../UsageLedger'
import { codexResetCredits } from './AccountProviderRuntime+CodexResets'
import { CodexHistorySource, CodexHistorySourceReport } from './CodexHistorySource'
import { CodexUsageClient } from './CodexUsageClient'
import { CodexUsageMapper } from './CodexUsageMapper'
import { CodexUsageReports } from './CodexUsageReports'

/** Upstream's `refreshCodex(_:)`, which lives in `AccountProviderRuntime.swift`. */
export async function refreshCodex(rt: AccountProviderRuntime, credential: AccountCredential): Promise<ProviderUsage> {
  const { tokens, response } = await rt.authorizedRead(credential, CodexLogin.refresh, (tokens) =>
    new CodexUsageClient(rt.http).fetchUsage(tokens.accessToken, tokens.extras['chatgpt_account_id'])
  )
  const accountID: string | undefined = tokens.extras['chatgpt_account_id']
  const resetCredits = await codexResetCredits(rt, response, tokens.accessToken, accountID)
  const usage = CodexUsageMapper.mapUsageResponse(response, resetCredits, rt.now())
  const countsSource = new CodexHistorySource(new CodexUsageClient(rt.http), tokens.accessToken, accountID, rt.cardID, 'counts')
  const planType = asString(ProviderParse.jsonObject(response.body)?.plan_type)
  const report = CodexHistorySourceReport.workspaceCredits(planType)
  if (report !== undefined) {
    const creditsSource = new CodexHistorySource(countsSource.client, countsSource.accessToken, countsSource.chatGPTAccountID, countsSource.cardID, report)
    // Both reports are read at once; neither read throws.
    const counted = refreshHistory(rt, countsSource)
    const credits = await refreshHistory(rt, creditsSource, rt.codexCreditsLedger)
    const counts = await counted
    if (counts !== undefined) usage.history = CodexUsageReports.combining(counts, credits)
  } else {
    const history = await refreshHistory(rt, countsSource)
    if (history !== undefined) usage.history = history
  }
  return usage
}
