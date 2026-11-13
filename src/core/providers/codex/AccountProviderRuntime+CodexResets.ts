import { AccountCredential, type OAuthTokens } from '../../models/Account'
import { CodexLogin } from '../../services/BrowserProviderLogins'
import type { HTTPResponse } from '../../services/HTTPClient'
import { ResetClaimFailure, ResetClaimOutcome, ResetClaimService } from '../../services/ResetClaimService'
import type { RefreshOutcome } from '../../stores/RefreshOutcome'
import { AppLog, describeError, LogTags } from '../../support/AppLog'
import { ProviderParse } from '../../support/ProviderParse'
import type { Instant } from '../../support/time'
import type { AccountProviderRuntime } from '../AccountProviderRuntime'
import { ProviderError } from '../ProviderError'
import { CodexUsageClient } from './CodexUsageClient'
import { CodexUsageMapper } from './CodexUsageMapper'

function isSuccess(response: HTTPResponse): boolean {
  return response.statusCode >= 200 && response.statusCode < 300
}

export async function codexResetCredits(
  rt: AccountProviderRuntime,
  usage: HTTPResponse,
  accessToken: string,
  accountID: string | undefined
): Promise<HTTPResponse | undefined> {
  if (!isSuccess(usage)) return undefined
  if (!rt.codexResetCreditsRead.isDue(rt.now())) return rt.codexResetCreditsRead.value
  try {
    const response = await new CodexUsageClient(rt.http).fetchResetCredits(accessToken, accountID)
    rt.codexResetCreditsRead.record(isSuccess(response) ? response : undefined, rt.now())
  } catch (error) {
    AppLog.warn(LogTags.plugin('codex'), `${rt.cardID} reset-credit fetch failed; retrying in an hour: ${describeError(error)}`)
    rt.codexResetCreditsRead.record(undefined, rt.now())
  }
  return rt.codexResetCreditsRead.value
}

/** How a claim's outcome reads in the log. */
function describeOutcome(outcome: ResetClaimOutcome): string {
  return outcome.type === 'failed' ? `failed(${outcome.failure})` : outcome.type
}

export async function claimCodexResetCredit(rt: AccountProviderRuntime, expiry: Instant, redeemRequestID: string): Promise<ResetClaimOutcome> {
  const tag = LogTags.plugin('codex')
  const cardID = rt.cardID
  let tokens: OAuthTokens
  try {
    tokens = await rt.freshTokens(await rt.loadCredential(), CodexLogin.refresh)
  } catch (error) {
    AppLog.error(tag, `${cardID} reset claim: couldn't prepare the claim: ${describeError(error)}`)
    return ResetClaimOutcome.failed(ResetClaimFailure.from(error))
  }
  const client = new CodexUsageClient(rt.http)
  const accountID: string | undefined = tokens.extras['chatgpt_account_id']
  rt.codexResetCreditsRead.forget()

  // A retry of a key that already matched replays the same (key, credit) pair instead of matching
  // again: after a consume whose answer was lost, the credit is gone from the list, and only the
  // replay lets the server's `already_redeemed` prove the claim landed.
  let creditID: string
  if (Object.hasOwn(rt.codexMatchedCreditIDs, redeemRequestID)) {
    creditID = rt.codexMatchedCreditIDs[redeemRequestID]
  } else {
    let list: HTTPResponse
    try {
      const read = await rt.authorizedRead(AccountCredential.oauth(tokens), CodexLogin.refresh, (tokens) =>
        client.fetchResetCredits(tokens.accessToken, accountID)
      )
      tokens = read.tokens
      list = read.response
    } catch (error) {
      AppLog.error(tag, `${cardID} reset claim: credit list fetch failed: ${describeError(error)}`)
      return ResetClaimOutcome.failed(ResetClaimFailure.from(error))
    }
    if (ProviderError.isAuthFailure(list)) {
      AppLog.error(tag, `${cardID} reset claim: credit list fetch rejected (HTTP ${list.statusCode})`)
      return ResetClaimOutcome.failed('signInExpired')
    }
    const body = isSuccess(list) ? ProviderParse.jsonObject(list.body) : undefined
    if (!body) {
      AppLog.error(tag, `${cardID} reset claim: credit list fetch failed (HTTP ${list.statusCode})`)
      return ResetClaimOutcome.failed('refused')
    }
    const matched = CodexUsageMapper.resetCreditID(body, expiry)
    if (matched === undefined) {
      AppLog.warn(tag, `${cardID} reset claim: no available credit matches the picked expiry`)
      return ResetClaimOutcome.noCredit
    }
    rt.codexMatchedCreditIDs[redeemRequestID] = matched
    creditID = matched
  }

  let response: HTTPResponse
  try {
    const read = await rt.authorizedRead(AccountCredential.oauth(tokens), CodexLogin.refresh, (tokens) =>
      client.consumeResetCredit(tokens.accessToken, accountID, creditID, redeemRequestID)
    )
    response = read.response
  } catch (error) {
    AppLog.error(tag, `${cardID} reset claim: consume request failed: ${describeError(error)}`)
    return ResetClaimOutcome.failed(ResetClaimFailure.from(error))
  }
  const outcome = CodexUsageMapper.resetClaimOutcome(response)
  if (outcome.type === 'success') {
    AppLog.info(tag, `${cardID} reset claim: claimed (HTTP ${response.statusCode})`)
  } else {
    AppLog.warn(tag, `${cardID} reset claim: ${describeOutcome(outcome)} (HTTP ${response.statusCode})`)
  }
  return outcome
}

/** The `.codex` case of upstream's `resetClaimService(refreshAccount:)`. */
export function codexResetClaimService(rt: AccountProviderRuntime, refreshAccount: () => Promise<RefreshOutcome>): ResetClaimService {
  return new ResetClaimService({
    accountID: rt.cardID,
    isClaimable: true,
    claimReset: (expiry, redeemRequestID) => claimCodexResetCredit(rt, expiry, redeemRequestID),
    refreshAccount
  })
}
