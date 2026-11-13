import { afterEach, describe, expect, it, vi } from 'vitest'
import { Account, AccountCredential, OAuthTokens } from '@core/models/Account'
import type { DashboardTab } from '@core/models/DashboardTab'
import { DashboardTab as DashboardTabs } from '@core/models/DashboardTab'
import type { Provider } from '@core/models/Provider'
import { UsageBreakdown, UsageHistory, UsageTotals, UsageWindow } from '@core/models/UsageHistory'
import { WidgetData } from '@core/models/WidgetData'
import { WidgetDescriptor } from '@core/models/WidgetDescriptor'
import { AccountProviderRuntime } from '@core/providers/AccountProviderRuntime'
import { ProviderError } from '@core/providers/ProviderError'
import { ClaudeSessions } from '@core/providers/claude/ClaudeSession'
import { CodexUsageReports } from '@core/providers/codex/CodexUsageReports'
import { CursorUsageClient } from '@core/providers/cursor/CursorUsageClient'
import { GrokUsageClient } from '@core/providers/grok/GrokUsageClient'
import type { CredentialVault } from '@core/services/AccountCredentialVault'
import { GrokLogin } from '@core/services/DeviceProviderLogins'
import { HTTPResponse, type HTTPRequest } from '@core/services/HTTPClient'
import { QuotaNotificationEvaluator } from '@core/stores/QuotaNotificationEvaluator'
import { Calendar } from '@core/support/Calendar'
import { OpenUsageISO8601 } from '@core/support/OpenUsageISO8601'
import { PaceMilestone } from '@core/support/PaceNotificationLogic'
import { DISTANT_FUTURE, DISTANT_PAST, addSeconds } from '@core/support/time'
import { HeldResponse, InMemoryCredentialVault, RoutingHTTPClient, TestSwitch, isolatedDefaults } from './TestSupport'
import { containerForTesting, makeAccountStore, settle, tick, waitUntil } from './support/accountHelpers'

const oauth = (accessToken: string, refreshToken?: string, expiresAt?: number): AccountCredential =>
  AccountCredential.oauth(OAuthTokens.make(accessToken, refreshToken, expiresAt))

const authorization = (request: HTTPRequest): string | undefined => request.headers?.Authorization

const same = (a: AccountCredential | undefined, b: AccountCredential | undefined): boolean => AccountCredential.equal(a, b)

describe('SignInAgainTests', () => {
  function usage(request: HTTPRequest): HTTPResponse {
    if (request.url === GrokUsageClient.settingsURL) return new HTTPResponse(200, {}, '{}')
    if (authorization(request) === 'Bearer rejected' || request.url === GrokLogin.tokenURL) return new HTTPResponse(401)
    // Grok's documented response for a valid team account.
    return new HTTPResponse(412, {}, '{"error":"principal has no personal team"}')
  }

  it('testRejectsNewOAuthCredentialWhenOnlyOldTokenCanReadUsage', async () => {
    const defaults = isolatedDefaults()
    const vault = new InMemoryCredentialVault()
    const accounts = makeAccountStore({ defaults, vault })
    const old = oauth('current', 'current-r')
    const account = accounts.add({ kind: 'grok', label: 'Work', credential: old })
    const container = containerForTesting(accounts, defaults, new RoutingHTTPClient(usage))
    const refused = oauth('rejected', 'bad-r')
    const result = await settle(container.replaceCredential(refused, Account.cardID(account)))
    expect(result.ok, 'Replacement reported success for the provider-rejected access and refresh tokens.').toBe(false)
    expect(same(vault.load(account.id), old), 'A rejected candidate overwrote the working login.').toBe(true)
  })

  // Upstream checks the popover's screen, tab, and sheet (`PopoverState`, AppKit glue). Here the
  // container reports a successful sign-in through `onSignedInAgain` with the Default Tab, and the panel
  // acts on it; the port checks that only a successful sign-in reports, with the Default Tab.
  it('testOnlyASuccessfulSignInAgainLeavesTheAccountPageForTheDefaultTab', async () => {
    const defaults = isolatedDefaults()
    defaults.set(DashboardTabs.defaultKey, 'allUsage')
    const accounts = makeAccountStore({ defaults })
    const account = accounts.add({ kind: 'grok', label: 'Work', credential: oauth('expired') })
    const cardID = Account.cardID(account)
    const container = containerForTesting(accounts, defaults, new RoutingHTTPClient(usage))
    const openedTabs: DashboardTab[] = []
    container.onSignedInAgain = (tab) => openedTabs.push(tab)

    await settle(container.signInAgain(oauth('rejected', 'bad-r'), cardID))
    const cancel = new AbortController()
    const cancelled = settle(container.signInAgain(oauth('new'), cardID, cancel.signal))
    cancel.abort()
    await cancelled
    expect(openedTabs, "A failed or cancelled sign-in left the account's page.").toEqual([])

    await container.signInAgain(oauth('new'), cardID)
    expect(openedTabs, 'A successful sign-in did not open the Default Tab.').toEqual(['allUsage'])
  })

  it('testOldOAuthRenewalCannotOverwriteTheNewSignIn', async () => {
    const defaults = isolatedDefaults()
    const vault = new InMemoryCredentialVault()
    const accounts = makeAccountStore({ defaults, vault })
    const old = oauth('old', 'old-r', DISTANT_PAST)
    const account = accounts.add({ kind: 'grok', label: 'Work', credential: old })
    const cardID = Account.cardID(account)
    const grant = new HeldResponse()
    const http = new RoutingHTTPClient(async (request) => {
      if (request.url === GrokLogin.tokenURL) {
        await grant.hold()
        return new HTTPResponse(200, {}, '{"access_token":"rotated-old","refresh_token":"rotated-old-r","expires_in":7200}')
      }
      return usage(request)
    })
    const container = containerForTesting(accounts, defaults, http)
    const oldRefresh = container.dataStore.refresh(cardID, true)
    await grant.waitUntilHeld()
    const fresh = oauth('new', 'new-r')
    const replacement = settle(container.replaceCredential(fresh, cardID))
    // Allow a replacement that serializes against the outstanding grant to wait for it.
    for (let index = 0; index < 100 && !same(vault.load(account.id), fresh); index++) await tick()
    grant.release()
    const result = await replacement
    if (!result.ok) throw result.error
    await oldRefresh
    expect(same(vault.load(account.id), fresh), 'The previous runtime rewrote the same Keychain slot after Sign In Again committed.').toBe(true)
  })
})

describe('PR1535ClaudeTests', () => {
  const login = (token: string, identity: string): AccountCredential =>
    AccountCredential.oauth(OAuthTokens.make(token, undefined, undefined, { [OAuthTokens.identityKey]: identity }))

  const successfulUsage = (): HTTPResponse => new HTTPResponse(200, {}, '{"five_hour":{"utilization":42}}')

  it('testARejectedSignInCantPassOnTheSavedTokensRequest', async () => {
    const defaults = isolatedDefaults()
    const vault = new InMemoryCredentialVault()
    const accounts = makeAccountStore({ defaults, vault })
    const saved = login('saved', 'same-login/same-org')
    const account = accounts.add({ kind: 'claude', label: 'Work', credential: saved })
    const cardID = Account.cardID(account)
    const savedRead = new HeldResponse()
    const http = new RoutingHTTPClient(async (request) => {
      if (authorization(request) !== 'Bearer saved') return new HTTPResponse(401)
      await savedRead.hold()
      return successfulUsage()
    })
    const container = containerForTesting(accounts, defaults, http)

    const refresh = container.dataStore.refresh(cardID, true)
    await savedRead.waitUntilHeld()

    const replacing = settle(container.replaceCredential(login('rejected', 'same-login/same-org'), cardID))
    await waitUntil(() => http.requests.some((request) => authorization(request) !== 'Bearer saved'))
    savedRead.release()
    await refresh

    const result = await replacing
    expect(
      http.requests.some((request) => authorization(request) !== 'Bearer saved'),
      'the new sign-in never asked for itself'
    ).toBe(true)
    expect(result.ok, "a rejected sign-in was accepted on the saved token's answer").toBe(false)
    expect(vault.load(account.id)).toEqual(saved)
  })

  it('testSignInAgainHonorsPersisted429ForTheSameClaudeIdentity', async () => {
    const defaults = isolatedDefaults()
    const identity = 'a4ae1535-bfe9-4489-a97a-c94672cc313a/1e89475b-246e-4833-86e0-af0c11874681'
    defaults.set(ClaudeSessions.storageKey, { [identity]: { until: addSeconds(Date.now(), 3600), strikes: 1 } })
    const vault = new InMemoryCredentialVault()
    const accounts = makeAccountStore({ defaults, vault })
    const account = accounts.add({ kind: 'claude', label: 'Work', credential: login('old', identity) })
    const cardID = Account.cardID(account)
    const http = new RoutingHTTPClient(() => successfulUsage())
    const container = containerForTesting(accounts, defaults, http)
    await container.dataStore.refresh(cardID, true)
    expect(http.requests.length, 'Control: the original runtime must observe the saved hold.').toBe(0)
    await settle(container.replaceCredential(login('new', identity), cardID))
    expect(
      http.requests.length,
      'Signing in again to the same login sent Claude a usage request inside its persisted 429 window.'
    ).toBe(0)
  })

  it('testClaude429AfterSignInAgainSurvivesRelaunch', async () => {
    const defaults = isolatedDefaults()
    const identity = 'claude-person/org'
    const vault = new InMemoryCredentialVault()
    const accounts = makeAccountStore({ defaults, vault })
    const account = accounts.add({ kind: 'claude', label: 'Work', credential: login('old', identity) })
    const cardID = Account.cardID(account)
    const limited = new TestSwitch(false)
    const http = new RoutingHTTPClient(() => {
      if (limited.value) return new HTTPResponse(429, { 'retry-after': '3600' })
      return successfulUsage()
    })
    const container = containerForTesting(accounts, defaults, http)
    await container.replaceCredential(login('new', identity), cardID)
    limited.value = true
    await container.dataStore.refresh(cardID, true)
    const requestsBeforeRelaunch = http.requests.length
    expect(requestsBeforeRelaunch).toBe(2)
    const relaunched = containerForTesting(accounts, defaults, http)
    await relaunched.dataStore.refresh(cardID, true)
    expect(http.requests.length, "The new runtime's 429 hold did not survive relaunch.").toBe(requestsBeforeRelaunch)
  })

  it('testSignInAgainCannotSilentlyReplaceTheSavedOAuthIdentity', async () => {
    const defaults = isolatedDefaults()
    const vault = new InMemoryCredentialVault()
    const accounts = makeAccountStore({ defaults, vault })
    const old = login('work-token', 'claude-work-user/work-org')
    const account = accounts.add({ kind: 'claude', label: 'work@example.test', credential: old })
    const cardID = Account.cardID(account)
    const http = new RoutingHTTPClient(() => successfulUsage())
    const container = containerForTesting(accounts, defaults, http)
    const personal = login('personal-token', 'claude-personal-user/personal-org')
    await settle(container.replaceCredential(personal, cardID))
    expect(accounts.account(cardID)?.label).toBe('work@example.test')
    const stored = vault.load(account.id)
    expect(
      stored === undefined ? undefined : AccountCredential.identity(stored),
      'A different provider identity now backs the existing work account.'
    ).toBe(AccountCredential.identity(old))
  })
})

describe('AlertLevelTests', () => {
  it('testOnlyEnabledHalfAlertStillFiresWhenAReadCrossesBothThresholds', async () => {
    const provider: Provider = { id: 'test', kind: 'cursor' }
    const descriptor = WidgetDescriptor.percent({ key: 'weekly', provider, title: 'Weekly' })
    const sent: string[] = []
    const evaluator = new QuotaNotificationEvaluator(async (id) => {
      sent.push(id)
      return true
    })
    for (const used of [40, 95, 95]) {
      await evaluator.evaluate(
        [descriptor],
        () => new WidgetData({ title: 'Weekly', kind: 'percent', used, limit: 100 }),
        (milestone) => milestone === PaceMilestone.warning,
        Date.now(),
        () => 'Cursor'
      )
    }
    expect(sent).toEqual([`test.${PaceMilestone.warning}`])
  })
})

describe('PR1535DetailsTests', () => {
  it('testASecondRecordWithoutAttributionKeepsTheFirstRecordsNamedTurnShare', () => {
    const named = '{"date":"2026-10-30","totals":{"turns":3,"text_total_tokens":9},"models":[{"model":"A","turns":3}]}'
    const unnamed = '{"date":"2026-10-30","totals":{"turns":1,"text_total_tokens":1}}'
    const date = OpenUsageISO8601.date('2026-10-30T00:00:00Z')
    if (date === undefined) throw new Error('bad date')
    for (const records of [
      [named, unnamed],
      [unnamed, named]
    ]) {
      const source = '{"data":[' + records.join(',') + ']}'
      const report = CodexUsageReports.counts(source)
      const day = report?.days.get('2026-10-30')
      if (!day) throw new Error('no day')
      const history = UsageHistory.make(Calendar.utc, date, new Map([[date, day]]))
      const details = UsageBreakdown.make(UsageWindow.today, history)
      expect(UsageTotals.get(details.totals, 'turns')).toBe(4)
      expect(UsageTotals.get(details.totals, 'tokens')).toBe(10)
      expect(UsageBreakdown.models(details, 'share').map((model) => model.name)).toEqual(['A'])
      expect(UsageBreakdown.models(details, 'share')[0]?.share).toBe(0.75)
    }
  })
})

describe('CodexModelTotalsTests', () => {
  it('testModelThatReportsTokensWithoutTurnsRetainsItsTokenRanking', () => {
    const source = '{"data":[{"date":"2026-10-30","totals":{"turns":2,"text_total_tokens":50},"models":[{"model":"A","credits":0,"text_total_tokens":50}]}]}'
    const report = CodexUsageReports.counts(source)
    const date = OpenUsageISO8601.date('2026-10-30T00:00:00Z')
    if (date === undefined) throw new Error('bad date')
    const day = report?.days.get('2026-10-30')
    if (!day) throw new Error('no day')
    const history = UsageHistory.make(Calendar.utc, date, new Map([[date, day]]))
    const details = UsageBreakdown.make(UsageWindow.today, history)
    expect(UsageBreakdown.models(details, 'tokens')[0]?.tokens).toBe(50)
  })
})

/** Refuses to save the candidate sign-in, when asked to. */
class RejectCandidateVault implements CredentialVault {
  readonly inner = new InMemoryCredentialVault()
  constructor(readonly rejectCandidate: boolean) {}
  load(id: string): AccountCredential | undefined {
    return this.inner.load(id)
  }
  save(credential: AccountCredential, id: string): void {
    if (this.rejectCandidate && credential.type === 'oauth' && credential.tokens.accessToken === 'candidate') {
      throw ProviderError.unavailable('Simulated write failure')
    }
    this.inner.save(credential, id)
  }
  update(credential: AccountCredential, id: string): void {
    this.inner.update(credential, id)
  }
  delete(id: string): void {
    this.inner.delete(id)
  }
}

/**
 * Holds the write of Cursor's legacy rotation until released. Upstream blocks the Keychain call on a
 * semaphore; the vault here is synchronous, so the held write is a promise the runtime awaits.
 */
class SlowCursorWriteVault implements CredentialVault {
  readonly inner = new InMemoryCredentialVault()
  readonly waiting = new TestSwitch(false)
  private releaseWrite: (() => void) | undefined
  load(id: string): AccountCredential | undefined {
    return this.inner.load(id)
  }
  save(credential: AccountCredential, id: string): void {
    this.inner.save(credential, id)
  }
  update(credential: AccountCredential, id: string): void {
    if (credential.type === 'oauth' && credential.tokens.accessToken === 'legacy-rotation') {
      this.waiting.value = true
      const held = new Promise<void>((resolve) => (this.releaseWrite = resolve)).then(() => this.inner.update(credential, id))
      return held as unknown as void
    }
    this.inner.update(credential, id)
  }
  delete(id: string): void {
    this.inner.delete(id)
  }
  release(): void {
    this.releaseWrite?.()
  }
}

describe('PR1535CancelTests', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  async function exercise(rejectCandidate: boolean): Promise<void> {
    const defaults = isolatedDefaults()
    const vault = new RejectCandidateVault(rejectCandidate)
    const accounts = makeAccountStore({ defaults, vault })
    const original = oauth('original', 'original-r', DISTANT_PAST)
    const account = accounts.add({ kind: 'grok', label: 'Work', credential: original })
    const cardID = Account.cardID(account)
    const grant = new HeldResponse()
    // Upstream sees the retiring runtime cancel its renewal's request. Requests aren't cancelled here:
    // `stopRenewals` waits the renewal out, so the probe watches for the call itself.
    const stopping = new TestSwitch(false)
    const stopRenewals = AccountProviderRuntime.prototype.stopRenewals
    vi.spyOn(AccountProviderRuntime.prototype, 'stopRenewals').mockImplementation(function (this: AccountProviderRuntime) {
      stopping.value = true
      return stopRenewals.call(this)
    })
    const alreadyRotated = new TestSwitch(false)
    const http = new RoutingHTTPClient(async (request) => {
      if (request.url === GrokLogin.tokenURL) {
        if (alreadyRotated.value) return new HTTPResponse(400, {}, '{"error":"invalid_grant"}')
        await grant.hold()
        alreadyRotated.value = true
        return new HTTPResponse(200, {}, '{"access_token":"rotated","refresh_token":"rotated-r","expires_in":7200}')
      }
      if (request.url === GrokUsageClient.settingsURL) return new HTTPResponse(200, {}, '{}')
      return new HTTPResponse(412, {}, '{"error":"principal has no personal team"}')
    })
    const container = containerForTesting(accounts, defaults, http)
    const oldRefresh = container.dataStore.refresh(cardID, true)
    await grant.waitUntilHeld()
    const candidate = oauth('candidate', 'candidate-r')
    const cancel = new AbortController()
    const replacement = settle(container.replaceCredential(candidate, cardID, cancel.signal))
    for (let index = 0; index < 200 && !stopping.value; index++) await tick()
    expect(stopping.value, 'Probe did not reach stopRenewals.').toBe(true)
    if (!rejectCandidate) cancel.abort()
    grant.release()
    await replacement
    await oldRefresh
    if (!rejectCandidate) {
      expect(same(vault.load(account.id), candidate), 'Cancelled sign-in still committed the candidate.').toBe(false)
      return
    }
    const recheck = await container.dataStore.refresh(cardID, true)
    expect(
      recheck,
      'The original refresh token had been rotated and the candidate’s save failed; the next poll must use the valid retained grant.'
    ).toBe('refreshed')
    expect(
      http.requests.filter((request) => request.url === GrokLogin.tokenURL).length,
      'The old runtime retried a spent refresh token.'
    ).toBe(1)
    const kept = vault.load(account.id)
    if (kept?.type !== 'oauth') throw new Error('The retained grant was lost.')
    expect(kept.tokens.refreshToken, 'The grant kept while renewals were stopped was not saved once they resumed.').toBe('rotated-r')
  }

  it('testCancelledSignInAgainDoesNotCommitWhileRetiringOldRuntime', async () => {
    await exercise(false)
  })

  it('testFailedReplacementKeepsAlreadyRotatedOriginalCredential', async () => {
    await exercise(true)
  })

  it('testAlreadyStartedCursorKeychainWriteCannotReplaceNewSignIn', async () => {
    const defaults = isolatedDefaults()
    const vault = new SlowCursorWriteVault()
    const accounts = makeAccountStore({ defaults, vault })
    const original = oauth('original', 'r', DISTANT_PAST)
    const account = accounts.add({ kind: 'cursor', label: 'Work', credential: original })
    const cardID = Account.cardID(account)
    const http = new RoutingHTTPClient((request) => {
      switch (request.url) {
        case CursorUsageClient.refreshURL:
          return new HTTPResponse(200, {}, '{"access_token":"legacy-rotation"}')
        case CursorUsageClient.usageURL:
          return new HTTPResponse(
            200,
            {},
            '{"billingCycleEnd":"1764547200000","billingCycleStart":"1761955200000","enabled":true,"planUsage":{"limit":2000,"remaining":1500,"totalPercentUsed":25}}'
          )
        case CursorUsageClient.planURL:
          return new HTTPResponse(200, {}, '{"planInfo":{"planName":"Pro"}}')
        default:
          return new HTTPResponse(404, {}, '{}')
      }
    })
    const container = containerForTesting(accounts, defaults, http)
    const oldRefresh = container.dataStore.refresh(cardID, true)
    for (let index = 0; index < 200 && !vault.waiting.value; index++) await tick()
    expect(vault.waiting.value).toBe(true)
    const candidate = oauth('candidate', 'candidate-r', DISTANT_FUTURE)
    const replacement = settle(container.replaceCredential(candidate, cardID))
    for (let index = 0; index < 200 && !same(vault.load(account.id), candidate); index++) await tick()
    vault.release()
    const result = await replacement
    if (!result.ok) throw result.error
    await oldRefresh
    expect(
      same(vault.load(account.id), candidate),
      "Cursor's old detached Keychain update finished after the new sign-in and overwrote it."
    ).toBe(true)
  })
})
