import type { HTTPResponse } from '../../services/HTTPClient'
import { ResetClaimFailure, ResetClaimOutcome, ResetClaimService } from '../../services/ResetClaimService'
import type { RefreshOutcome } from '../../stores/RefreshOutcome'
import { AppLog, describeError, LogTags } from '../../support/AppLog'
import type { AccountProviderRuntime } from '../AccountProviderRuntime'
import { ProviderError } from '../ProviderError'
import { ZAIReset, ZAIResetsMapper } from './ZAIResets'
import { ZAIUsageClient } from './ZAIUsageClient'

/** The `.zai` case of `resetClaimService(refreshAccount:)`: the banked resets, each claimed by its exact record. */
export function zaiResetClaimService(rt: AccountProviderRuntime, refreshAccount: () => Promise<RefreshOutcome>): ResetClaimService {
  return new ResetClaimService({
    accountID: rt.cardID,
    isClaimable: false,
    refreshAccount,
    windowResets: unexpiredZAIResets(rt) ?? [],
    claimWindowReset: (reset, requestID) => claimZAIReset(rt, reset, requestID)
  })
}

/**
 * Reads the banked resets at most once an hour, in the secondary-reads slot. A failure here only
 * costs the Limit Resets row, never the meters.
 */
export async function zaiResets(rt: AccountProviderRuntime, apiKey: string): Promise<ZAIReset[] | undefined> {
  if (!rt.zaiResetsRead.isDue(rt.now())) return unexpiredZAIResets(rt)
  try {
    rt.zaiResetsRead.record(await readZAIResets(rt, apiKey), rt.now())
  } catch (error) {
    AppLog.warn(LogTags.plugin('zai'), `${rt.cardID} reset list fetch failed; retrying in an hour: ${describeError(error)}`)
    rt.zaiResetsRead.record(undefined, rt.now())
  }
  return unexpiredZAIResets(rt)
}

/** The last list read, less the resets that have expired since. */
export function unexpiredZAIResets(rt: AccountProviderRuntime): ZAIReset[] | undefined {
  const now = rt.now()
  return rt.zaiResetsRead.value?.filter((reset) => reset.expiresAt > now)
}

/**
 * Spends exactly the record the user confirmed, and only while it is still its window's earliest.
 * Anything else answers `noCredit`, and the refresh after it shows the list to confirm again. A
 * request whose answer never arrives is not retried. The post-claim refresh rereads the list.
 */
export async function claimZAIReset(rt: AccountProviderRuntime, reset: ZAIReset, requestID: string): Promise<ResetClaimOutcome> {
  const tag = LogTags.plugin('zai')
  const cardID = rt.cardID
  let apiKey: string
  let current: ZAIReset[]
  try {
    const credential = await rt.loadCredential()
    if (credential.type !== 'apiKey') throw ProviderError.invalidResponse
    apiKey = credential.key
    current = await readZAIResets(rt, apiKey)
  } catch (error) {
    AppLog.error(tag, `${cardID} reset claim: couldn't read the reset list: ${describeError(error)}`)
    return ResetClaimOutcome.failed(ResetClaimFailure.from(error))
  }
  if (
    !ZAIReset.equal(
      current.find((candidate) => candidate.window === reset.window),
      reset
    )
  ) {
    AppLog.warn(tag, `${cardID} reset claim: the confirmed reset is no longer its window's earliest`)
    return ResetClaimOutcome.noCredit
  }

  let response: HTTPResponse
  try {
    response = await new ZAIUsageClient(rt.http).useReset(reset, requestID, apiKey)
  } catch (error) {
    AppLog.error(tag, `${cardID} reset claim: request failed: ${describeError(error)}`)
    return ResetClaimOutcome.failed(ResetClaimFailure.from(error))
  }
  const outcome = ZAIResetsMapper.claimOutcome(response)
  if (outcome.type === 'success') {
    AppLog.info(tag, `${cardID} reset claim: claimed (HTTP ${response.statusCode})`)
  } else {
    AppLog.warn(tag, `${cardID} reset claim: ${outcome.type === 'failed' ? `failed(${outcome.failure})` : outcome.type} (HTTP ${response.statusCode})`)
  }
  return outcome
}

async function readZAIResets(rt: AccountProviderRuntime, apiKey: string): Promise<ZAIReset[]> {
  const response = await new ZAIUsageClient(rt.http).fetchResets(apiKey)
  ProviderError.requireSuccess(response, 'zai')
  return ZAIResetsMapper.resets(response.body, rt.now())
}
