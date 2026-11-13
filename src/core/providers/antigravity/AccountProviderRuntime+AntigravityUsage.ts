import type { AccountCredential } from '../../models/Account'
import { AntigravityLogin } from '../../services/BrowserProviderLogins'
import { AppLog } from '../../support/AppLog'
import type { AccountProviderRuntime } from '../AccountProviderRuntime'
import { ProviderError } from '../ProviderError'
import { ProviderUsage } from '../ProviderRuntime'
import { AntigravityUsageClient, AntigravityUsageClientTokenRefused } from './AntigravityUsageClient'
import { AntigravityUsageMapper } from './AntigravityUsageMapper'

/**
 * Antigravity's usage read with the sign-in renewed once on a 401, the way `authorizedRead` does it
 * for one response: a second 401 is the expired sign-in.
 */
export async function refreshAntigravity(rt: AccountProviderRuntime, credential: AccountCredential): Promise<ProviderUsage> {
  const tokens = await rt.freshTokens(credential, AntigravityLogin.refresh)
  try {
    return await antigravityUsage(rt, tokens.accessToken)
  } catch (error) {
    if (!(error instanceof AntigravityUsageClientTokenRefused)) throw error
    AppLog.debug('auth', `${rt.cardID} usage read unauthorized; renewing the sign-in once`)
    const renewed = await rt.renewedTokens(tokens, AntigravityLogin.refresh)
    try {
      return await antigravityUsage(rt, renewed.accessToken)
    } catch (error) {
      if (error instanceof AntigravityUsageClientTokenRefused) throw ProviderError.signInExpired('antigravity')
      throw error
    }
  }
}

async function antigravityUsage(rt: AccountProviderRuntime, token: string): Promise<ProviderUsage> {
  const client = new AntigravityUsageClient(rt.http)
  if (rt.planBodyRead.isDue(rt.now())) {
    let fresh: Uint8Array | undefined
    try {
      fresh = await client.loadCodeAssist(token)
    } catch {
      fresh = undefined
    }
    if (fresh !== undefined) rt.planBodyRead.record(fresh, rt.now())
  }
  const codeAssist = rt.planBodyRead.value
  const bodies = await client.quotaSummary(token, codeAssist === undefined ? undefined : AntigravityUsageMapper.parseProject(codeAssist))
  const lines = AntigravityUsageMapper.parseQuotaSummaries(bodies)
  if (!lines) throw ProviderError.invalidResponse
  return ProviderUsage.make(codeAssist === undefined ? undefined : AntigravityUsageMapper.parseLoadCodeAssistPlan(codeAssist), lines)
}
