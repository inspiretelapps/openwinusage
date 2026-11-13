import { AccountCredential, type OAuthTokens } from '../../models/Account'
import { ClaudeLogin } from '../../services/BrowserProviderLogins'
import type { HTTPResponse } from '../../services/HTTPClient'
import { ResetClaimFailure, ResetClaimOutcome, ResetClaimService, type ResetClaimServiceFields } from '../../services/ResetClaimService'
import type { RefreshOutcome } from '../../stores/RefreshOutcome'
import { AppLog, describeError, LogTags } from '../../support/AppLog'
import { ProviderParse } from '../../support/ProviderParse'
import { DISTANT_PAST, secondsBetween, type Instant, type Seconds } from '../../support/time'
import type { AccountProviderRuntime } from '../AccountProviderRuntime'
import { ProviderError } from '../ProviderError'
import { readClaudeProfile } from './AccountProviderRuntime+ClaudeUsage'
import { ClaudeResetGrantStatus } from './ClaudeResetGrantStatus'
import type { ClaudeSession } from './ClaudeSession'
import { ClaudeUsageClient } from './ClaudeUsageClient'
import { ClaudeUsageMapper } from './ClaudeUsageMapper'

export interface ClaudeResetGrantsCheck {
  checkedAt: Instant
  status?: ClaudeResetGrantStatus
}

export class ClaudeResetGrantsState {
  check: ClaudeResetGrantsCheck | undefined
  claimEpoch = 0
  unsettledClaim: { grantID: string; requestID: string } | undefined

  isOlder(age: Seconds, now: Instant): boolean {
    return this.check === undefined ? true : secondsBetween(now, this.check.checkedAt) >= age
  }

  settleClaim(grantID: string, outcome: ResetClaimOutcome, resetsLeft: number | undefined): void {
    this.claimEpoch += 1
    if (this.check) this.check = { ...this.check, checkedAt: DISTANT_PAST }
    const status = this.check?.status
    const index = status?.grants.findIndex((grant) => grant.id === grantID) ?? -1
    if (outcome.type !== 'success' || !this.check || !status || index < 0) return
    const grants = status.grants.map((grant) => ({ ...grant }))
    grants[index].resetsLeft = Math.max(0, resetsLeft ?? grants[index].resetsLeft - 1)
    this.check = { ...this.check, status: { ...status, grants } }
  }
}

/**
 * Reads the login's reset grants, at most once an hour in the secondary-reads slot. Claude Code itself
 * only asks occasionally, and sending the reset-grants request on every refresh brought sustained 429s
 * on the usage endpoint. A failure here only costs the row, never the bars.
 */
export async function readClaudeResetGrants(rt: AccountProviderRuntime, session: ClaudeSession, accessToken: string): Promise<void> {
  const now = rt.now()
  const previous = session.resetGrants.check
  const epoch = session.resetGrants.claimEpoch
  try {
    const client = new ClaudeUsageClient(rt.http)
    const response = await session.send(now, () => client.fetchResetGrants(accessToken))
    const status = ClaudeUsageMapper.mapResetGrantStatus(response)
    if (session.resetGrants.claimEpoch === epoch) {
      session.resetGrants.check = status === undefined ? { checkedAt: now } : { checkedAt: now, status }
    }
  } catch (error) {
    // Upstream also leaves the check alone when the read was cancelled; a read here is never cancelled.
    if (session.resetGrants.claimEpoch !== epoch) return
    AppLog.warn(LogTags.plugin('claude'), `${rt.cardID} reset grants lookup failed; retrying in an hour: ${describeError(error)}`)
    session.resetGrants.check = previous?.status === undefined ? { checkedAt: now } : { checkedAt: now, status: previous.status }
  }
}

const grantIDPattern = /^[a-z0-9_-]{1,40}$/
const requestIDPattern = /^[A-Za-z0-9_-]{1,64}$/

/** How a claim's outcome reads in the log. */
function describeOutcome(outcome: ResetClaimOutcome): string {
  return outcome.type === 'failed' ? `failed(${outcome.failure})` : outcome.type
}

export async function claimClaudeResetGrant(rt: AccountProviderRuntime, redeemRequestID: string): Promise<ResetClaimOutcome> {
  const tag = LogTags.plugin('claude')
  const cardID = rt.cardID
  const session = rt.claude.session
  const checked = session?.resetGrants.check?.status
  const grantID = checked === undefined ? undefined : ClaudeResetGrantStatus.claimableGrantID(checked)
  if (!session || grantID === undefined) {
    AppLog.warn(tag, `${cardID} reset claim: no claimable grant in the last reset-grants check`)
    return ResetClaimOutcome.noCredit
  }
  // A claim whose answer never arrived may have landed. Retrying it under its original request id
  // lets Anthropic answer `already_used` instead of spending another reset from the same grant.
  const unsettled = session.resetGrants.unsettledClaim
  const requestID = unsettled?.grantID === grantID ? unsettled.requestID : redeemRequestID
  if (!grantIDPattern.test(grantID) || !requestIDPattern.test(requestID)) {
    AppLog.error(tag, `${cardID} reset claim: refusing a malformed grant id or request id`)
    return ResetClaimOutcome.failed('refused')
  }

  let tokens: OAuthTokens
  let organizationUUID: string
  try {
    tokens = await rt.freshTokens(await rt.loadCredential(), ClaudeLogin.refresh)
    if (session.organizationUUID === undefined) await readClaudeProfile(rt, session, tokens)
    const uuid = session.organizationUUID
    if (uuid === undefined) throw ProviderError.invalidResponse
    organizationUUID = uuid
  } catch (error) {
    AppLog.error(tag, `${cardID} reset claim: couldn't prepare the claim: ${describeError(error)}`)
    return ResetClaimOutcome.failed(ResetClaimFailure.from(error))
  }

  let response: HTTPResponse
  try {
    const read = await rt.authorizedRead(AccountCredential.oauth(tokens), ClaudeLogin.refresh, (tokens) =>
      new ClaudeUsageClient(rt.http).claimResetGrant(tokens.accessToken, organizationUUID, grantID, requestID)
    )
    response = read.response
  } catch (error) {
    AppLog.error(tag, `${cardID} reset claim: request failed: ${describeError(error)}`)
    session.resetGrants.unsettledClaim = { grantID, requestID }
    return ResetClaimOutcome.failed(ResetClaimFailure.from(error))
  }
  const succeeded = response.statusCode >= 200 && response.statusCode < 300
  const body = succeeded ? ProviderParse.jsonObject(response.body) : undefined
  if (body !== undefined && body.result !== undefined) {
    session.resetGrants.unsettledClaim = undefined
  } else if (succeeded || response.statusCode >= 500) {
    session.resetGrants.unsettledClaim = { grantID, requestID }
  }
  const outcome = ClaudeUsageMapper.resetClaimOutcome(response)
  if (outcome.type === 'success') {
    AppLog.info(tag, `${cardID} reset claim: claimed (HTTP ${response.statusCode})`)
  } else {
    AppLog.warn(tag, `${cardID} reset claim: ${describeOutcome(outcome)} (HTTP ${response.statusCode})`)
  }
  switch (outcome.type) {
    case 'success':
    case 'unconfirmed':
    case 'noCredit': {
      const left = ProviderParse.number(body?.resets_left)
      const resetsLeft = left === undefined ? undefined : ProviderParse.int(Math.floor(left))
      session.resetGrants.settleClaim(grantID, outcome, resetsLeft)
      break
    }
    case 'nothingToReset':
    case 'unavailableNow':
    case 'failed':
      break
  }
  return outcome
}

/** The `.claude` case of upstream's `resetClaimService(refreshAccount:)`. */
export function claudeResetClaimService(rt: AccountProviderRuntime, refreshAccount: () => Promise<RefreshOutcome>): ResetClaimService {
  const status = rt.claude.session?.resetGrants.check?.status
  const fields: ResetClaimServiceFields = {
    accountID: rt.cardID,
    isClaimable: status !== undefined && ClaudeResetGrantStatus.claimableGrantID(status) !== undefined,
    claimReset: (_expiry, redeemRequestID) => claimClaudeResetGrant(rt, redeemRequestID),
    refreshAccount
  }
  const confirmDetail = status === undefined ? undefined : ClaudeResetGrantStatus.confirmDetail(status)
  if (confirmDetail !== undefined) fields.confirmDetail = confirmDetail
  return new ResetClaimService(fields)
}
