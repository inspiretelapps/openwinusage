import { NetworkError } from '../models/ProviderSnapshot'
import { ProviderError } from '../providers/ProviderError'
import type { ZAIReset } from '../providers/zai/ZAIResets'
import type { RefreshOutcome } from '../stores/RefreshOutcome'
import { AppLog } from '../support/AppLog'
import { Formatters } from '../support/Formatters'
import type { Instant } from '../support/time'

export type ResetClaimFailure = 'signInExpired' | 'notPermitted' | 'connection' | 'refused'

export const ResetClaimFailure = {
  from(error: unknown): ResetClaimFailure {
    if (ProviderError.is(error, 'signInExpired')) return 'signInExpired'
    if (error instanceof NetworkError || ProviderError.is(error, 'connectionFailed') || ProviderError.is(error, 'unreachable')) return 'connection'
    return 'refused'
  }
}

export type ResetClaimOutcome =
  | { type: 'success' }
  | { type: 'nothingToReset' }
  | { type: 'noCredit' }
  | { type: 'unconfirmed' }
  | { type: 'unavailableNow'; until?: Instant }
  | { type: 'failed'; failure: ResetClaimFailure }

export const ResetClaimOutcome = {
  success: { type: 'success' } as ResetClaimOutcome,
  nothingToReset: { type: 'nothingToReset' } as ResetClaimOutcome,
  noCredit: { type: 'noCredit' } as ResetClaimOutcome,
  unconfirmed: { type: 'unconfirmed' } as ResetClaimOutcome,
  unavailableNow: (until?: Instant): ResetClaimOutcome => (until === undefined ? { type: 'unavailableNow' } : { type: 'unavailableNow', until }),
  failed: (failure: ResetClaimFailure): ResetClaimOutcome => ({ type: 'failed', failure }),

  message(outcome: ResetClaimOutcome, now: Instant = Date.now()): string {
    switch (outcome.type) {
      case 'success':
        return 'Reset claimed. Enjoy!'
      case 'nothingToReset':
        return "Your usage doesn't need a reset yet"
      case 'noCredit':
        return 'That reset is no longer available'
      case 'unconfirmed':
        return 'Your reset may still be going through. Check again in a minute.'
      case 'unavailableNow': {
        const when = outcome.until === undefined ? undefined : Formatters.whenLabel(outcome.until, 'relative', now)
        const tail = when === undefined ? '' : when === Formatters.imminent ? ' Try again soon.' : ` Try again in ${when}.`
        return "Resets can't be used right now." + tail
      }
      case 'failed':
        switch (outcome.failure) {
          case 'signInExpired':
            return "Your sign-in expired. Sign in again from the account's page."
          case 'notPermitted':
            return "This sign-in can't use resets. Use the reset in Claude Code instead."
          case 'connection':
            return "Couldn't connect. Check your internet connection and try again."
          case 'refused':
            return "Couldn't reset usage. Please try again."
        }
    }
  }
}

export interface ResetClaimServiceFields {
  accountID: string
  isClaimable: boolean
  confirmDetail?: string
  claimReset?: (expiry: Instant, redeemRequestID: string) => Promise<ResetClaimOutcome>
  refreshAccount: () => Promise<RefreshOutcome>
  /** Resets that each refill one window (Z.ai), earliest first, claimed by their exact record. */
  windowResets?: ZAIReset[]
  claimWindowReset?: (reset: ZAIReset, requestID: string) => Promise<ResetClaimOutcome>
}

export class ResetClaimService {
  readonly accountID: string
  readonly isClaimable: boolean
  readonly confirmDetail?: string
  readonly claimReset?: (expiry: Instant, redeemRequestID: string) => Promise<ResetClaimOutcome>
  readonly refreshAccount: () => Promise<RefreshOutcome>
  windowResets: ZAIReset[]
  claimWindowReset?: (reset: ZAIReset, requestID: string) => Promise<ResetClaimOutcome>

  constructor(fields: ResetClaimServiceFields) {
    this.accountID = fields.accountID
    this.isClaimable = fields.isClaimable
    this.confirmDetail = fields.confirmDetail
    this.claimReset = fields.claimReset
    this.refreshAccount = fields.refreshAccount
    this.windowResets = fields.windowResets ?? []
    this.claimWindowReset = fields.claimWindowReset
  }

  /** The claim's result shows first; the refresh that drops the spent row starts at once behind it. */
  async claim(creditExpiringAt: Instant, redeemRequestID: string): Promise<ResetClaimOutcome> {
    if (!this.claimReset) return ResetClaimOutcome.noCredit
    return this.settle(await this.claimReset(creditExpiringAt, redeemRequestID))
  }

  async claimWindow(reset: ZAIReset, requestID: string): Promise<ResetClaimOutcome> {
    if (!this.claimWindowReset) return ResetClaimOutcome.noCredit
    return this.settle(await this.claimWindowReset(reset, requestID))
  }

  private settle(outcome: ResetClaimOutcome): ResetClaimOutcome {
    if (outcome.type === 'failed') return outcome
    void this.refreshAfterClaim()
    return outcome
  }

  private async refreshAfterClaim(): Promise<void> {
    const outcome = await this.refreshAccount()
    if (outcome === 'refreshed' || outcome === 'cacheHit') return
    AppLog.warn('refresh', `${this.accountID} post-claim refresh ${outcome}; meters may lag until the next pass`)
  }
}
