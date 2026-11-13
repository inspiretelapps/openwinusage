import { Account, AccountCredential, OAuthTokens, ProviderKind } from '../models/Account'
import { HubLink } from '../models/CLIProxyHub'
import { HistoryRow } from '../models/HistoryRow'
import type { MetricLine } from '../models/MetricLine'
import { Provider } from '../models/Provider'
import { ProviderSnapshot, RefreshFailure, type RefreshResult } from '../models/ProviderSnapshot'
import type { WidgetDescriptor } from '../models/WidgetDescriptor'
import type { CredentialVault } from '../services/AccountCredentialVault'
import { HubRefusal } from '../services/CLIProxyHubClient'
import type { HTTPClient, HTTPResponse } from '../services/HTTPClient'
import type { OAuthGrant } from '../services/OAuthLoginSupport'
import type { ResetClaimService } from '../services/ResetClaimService'
import type { RefreshOutcome } from '../stores/RefreshOutcome'
import { AppLog, describeError } from '../support/AppLog'
import { addSeconds, DISTANT_PAST, type Clock, type Instant } from '../support/time'
import { widgetDescriptors } from './AccountProviderRuntime+Descriptors'
import { ProviderError } from './ProviderError'
import type { ProviderRuntime, ProviderUsage } from './ProviderRuntime'
import { SecondaryRead } from './SecondaryRead'
import { UsageLedger } from './UsageLedger'
import { refreshAntigravity } from './antigravity/AccountProviderRuntime+AntigravityUsage'
import { claudeResetClaimService } from './claude/AccountProviderRuntime+ClaudeResets'
import { ClaudeAccountState, refreshClaude, refreshClaudeHourlyReads, restoreClaude } from './claude/AccountProviderRuntime+ClaudeUsage'
import { ClaudeSessions } from './claude/ClaudeSession'
import { codexResetClaimService } from './codex/AccountProviderRuntime+CodexResets'
import { refreshCodex } from './codex/AccountProviderRuntime+CodexUsage'
import { refreshCopilot } from './copilot/AccountProviderRuntime+CopilotUsage'
import { refreshCursor } from './cursor/AccountProviderRuntime+CursorUsage'
import { refreshDevin } from './devin/AccountProviderRuntime+DevinUsage'
import { refreshGrok } from './grok/AccountProviderRuntime+GrokUsage'
import { refreshMuse } from './muse/AccountProviderRuntime+MuseUsage'
import { refreshOllama } from './ollama/AccountProviderRuntime+OllamaUsage'
import { refreshOpenCode } from './opencode/AccountProviderRuntime+OpenCodeUsage'
import { refreshOpenRouter } from './openrouter/AccountProviderRuntime+OpenRouterUsage'
import { zaiResetClaimService } from './zai/AccountProviderRuntime+ZAIResets'
import { refreshZAI } from './zai/AccountProviderRuntime+ZAIUsage'
import type { ZAIReset } from './zai/ZAIResets'

/** Trades a refresh token for new tokens: `(refreshToken, http, now)`. Each OAuth login exports one as `XLogin.refresh`. */
export type TokenGrant = (refreshToken: string, http: HTTPClient, now: Instant) => Promise<OAuthGrant>

/**
 * Runs one account: loads its credential, calls the provider's usage read, and returns a snapshot.
 * Each provider's read lives in its own folder as `refresh<Name>(rt, credential)`; the state those reads
 * keep between refreshes (hourly reads, ledgers) lives here, on the runtime.
 */
export class AccountProviderRuntime implements ProviderRuntime {
  account: Account
  provider: Provider
  vault: CredentialVault
  readonly http: HTTPClient
  readonly now: Clock
  planRead = new SecondaryRead<string>()
  planBodyRead = new SecondaryRead<Uint8Array>()
  codexResetCreditsRead = new SecondaryRead<HTTPResponse>()
  zaiResetsRead = new SecondaryRead<ZAIReset[]>()
  cursorMembershipRead = new SecondaryRead<string>()
  readonly usageLedger = new UsageLedger()
  readonly codexCreditsLedger = new UsageLedger()
  claude: ClaudeAccountState
  codexMatchedCreditIDs: Record<string, string> = {}
  museLastKnown: MetricLine[] = []
  /**
   * One renewal at a time: a provider that rotates refresh tokens refuses a second renewal sent with
   * the same one, so a caller that needs a renewal while one is in flight waits for its tokens, and a
   * caller whose tokens another renewal already replaced takes the stored ones.
   */
  private renewal: Promise<OAuthTokens> | undefined
  /**
   * Tokens a renewal granted that the vault refused to save. The provider may already have spent
   * the refresh token they replace, so they stand in for the stored credential until they are saved.
   */
  private unsavedRenewal: OAuthTokens | undefined
  private renewalsStopped = false
  /** Set while a new sign-in is proving itself, so nothing else's answer can stand in for its own. */
  isCheckingNewSignIn = false
  private credentialWrite: Promise<void> | undefined
  /** A token endpoint that rate-limited an early renewal is not asked again for an early one before this. */
  private earlyRenewalNotBefore: Instant = DISTANT_PAST

  constructor(
    account: Account,
    vault: CredentialVault,
    http: HTTPClient,
    now: Clock = Date.now,
    claudeSessions: ClaudeSessions = new ClaudeSessions()
  ) {
    this.account = account
    this.claude = new ClaudeAccountState(claudeSessions)
    this.vault = vault
    this.http = http
    this.now = now
    this.provider = AccountProviderRuntime.provider(account)
  }

  get widgetDescriptors(): WidgetDescriptor[] {
    return widgetDescriptors(this.account)
  }

  /** The account's card id, `claude@1a2b3c4d`. */
  get cardID(): string {
    return Account.cardID(this.account)
  }

  update(account: Account): void {
    this.account = account
    this.provider = AccountProviderRuntime.provider(account)
  }

  forgetHourlyReads(): void {
    this.planRead.forget()
    this.planBodyRead.forget()
    this.codexResetCreditsRead.forget()
    this.zaiResetsRead.forget()
    this.cursorMembershipRead.forget()
    this.usageLedger.forgetLastRead()
    this.codexCreditsLedger.forgetLastRead()
    this.claude.forcedReadsPending = true
  }

  static provider(account: Account): Provider {
    return Provider.forAccount(account)
  }

  resetClaimService(refreshAccount: () => Promise<RefreshOutcome>): ResetClaimService | undefined {
    switch (this.account.kind) {
      case 'claude':
        return claudeResetClaimService(this, refreshAccount)
      case 'codex':
        return codexResetClaimService(this, refreshAccount)
      case 'zai':
        return zaiResetClaimService(this, refreshAccount)
      case 'cursor':
      case 'antigravity':
      case 'copilot':
      case 'devin':
      case 'grok':
      case 'muse':
      case 'ollama':
      case 'opencode':
      case 'openrouter':
        return undefined
    }
  }

  restore(snapshot: ProviderSnapshot): void {
    switch (this.account.kind) {
      case 'claude':
        restoreClaude(this, snapshot)
        break
      case 'muse':
        this.museLastKnown = snapshot.lines
        break
      default:
        break
    }
  }

  async refreshHourlyReads(snapshot: ProviderSnapshot): Promise<ProviderSnapshot | undefined> {
    if (this.account.kind !== 'claude') return undefined
    return refreshClaudeHourlyReads(this, snapshot)
  }

  async refresh(): Promise<RefreshResult> {
    try {
      return { ok: true, snapshot: await this.readSnapshot(await this.loadCredential()) }
    } catch (error) {
      return { ok: false, failure: RefreshFailure.fromError(error) }
    }
  }

  async loadCredential(): Promise<AccountCredential> {
    if (this.unsavedRenewal) {
      const tokens = this.unsavedRenewal
      await this.saveRenewal(tokens)
      return AccountCredential.oauth(tokens)
    }
    const credential = await this.vault.load(this.account.id)
    if (!credential) throw this.refusedCredential
    return credential
  }

  /**
   * A refused sign-in has to be added again; a refused key or token can be replaced on the page; a
   * hub's login is fixed on the hub.
   */
  private get refusedCredential(): ProviderError {
    if (this.account.hub) return HubRefusal.error({ type: 'noToken' }, HubLink.host(this.account.hub), undefined)
    switch (Account.authMethod(this.account).type) {
      case 'oauth':
        return ProviderError.signInExpired(this.account.kind)
      case 'apiKey':
        return ProviderError.keyRejected(`${ProviderKind.displayName(this.account.kind)} rejected the API key.`)
      case 'organizationToken':
        return ProviderError.keyRejected('GitHub rejected the token.')
    }
  }

  private async readUsage(credential: AccountCredential): Promise<ProviderUsage> {
    try {
      switch (this.account.kind) {
        case 'claude':
          return await refreshClaude(this, credential)
        case 'codex':
          return await refreshCodex(this, credential)
        case 'cursor':
          return await refreshCursor(this, credential)
        case 'antigravity':
          return await refreshAntigravity(this, credential)
        case 'copilot':
          return await refreshCopilot(this, credential)
        case 'devin':
          return await refreshDevin(this, credential)
        case 'grok':
          return await refreshGrok(this, credential)
        case 'muse':
          return await refreshMuse(this, credential)
        case 'ollama':
          return await refreshOllama(this, credential)
        case 'opencode':
          return await refreshOpenCode(this, credential)
        case 'openrouter':
          return await refreshOpenRouter(this, credential)
        case 'zai':
          return await refreshZAI(this, credential)
      }
    } catch (error) {
      if (ProviderError.is(error, 'signInExpired')) throw this.refusedCredential
      throw error
    }
  }

  /** The credential's tokens, renewed first when they expire within the refresh margin. */
  async freshTokens(credential: AccountCredential, grant: TokenGrant): Promise<OAuthTokens> {
    if (credential.type !== 'oauth') throw ProviderError.invalidResponse
    const tokens = credential.tokens
    const expiresAt = tokens.expiresAt
    if (!OAuthTokens.needsRefresh(tokens, this.now()) || expiresAt === undefined) return tokens
    if (this.earlyRenewalIsHeld(expiresAt)) return tokens
    try {
      return await this.renewedTokens(tokens, grant)
    } catch (error) {
      if (!(expiresAt > this.now())) throw error
      this.holdEarlyRenewal(error)
      AppLog.warn('auth', `${this.cardID} early token renewal failed; keeping the current token: ${describeError(error)}`)
      return tokens
    }
  }

  /**
   * The usage read with the sign-in renewed once when the provider refuses the access token (401):
   * a token whose expiry the login never reported, or one the provider cut short, is renewed through
   * the account's own refresh token and the read retried; a second 401 is the expired sign-in. No
   * other answer renews.
   */
  async authorizedRead(
    credential: AccountCredential,
    grant: TokenGrant,
    read: (tokens: OAuthTokens) => Promise<HTTPResponse>
  ): Promise<{ tokens: OAuthTokens; response: HTTPResponse }> {
    let tokens = await this.freshTokens(credential, grant)
    let response = await read(tokens)
    if (response.statusCode !== 401 || tokens.refreshToken === undefined) return { tokens, response }
    AppLog.debug('auth', `${this.cardID} usage read unauthorized; renewing the sign-in once`)
    tokens = await this.renewedTokens(tokens, grant)
    response = await read(tokens)
    return { tokens, response }
  }

  /** Renews the tokens now, whatever their expiry, sharing a renewal that is already in flight. */
  async renewedTokens(tokens: OAuthTokens, grant: TokenGrant): Promise<OAuthTokens> {
    if (this.renewal) return this.renewal
    const refreshToken = tokens.refreshToken
    if (refreshToken === undefined) return tokens
    const renewal = (async (): Promise<OAuthTokens> => {
      try {
        let stored: AccountCredential | undefined
        try {
          stored = await this.loadCredential()
        } catch {
          stored = undefined
        }
        if (stored?.type === 'oauth' && stored.tokens.accessToken !== tokens.accessToken) return stored.tokens
        const renewed: OAuthTokens = { ...tokens, extras: { ...tokens.extras } }
        const granted = await grant(refreshToken, this.http, this.now())
        renewed.accessToken = granted.accessToken
        if (granted.refreshToken !== undefined) renewed.refreshToken = granted.refreshToken
        if (granted.expiresAt === undefined) delete renewed.expiresAt
        else renewed.expiresAt = granted.expiresAt
        await this.saveRenewal(renewed)
        return renewed
      } finally {
        this.renewal = undefined
      }
    })()
    this.renewal = renewal
    return renewal
  }

  /** The body of a 2xx response, or undefined. */
  successBody(response: HTTPResponse | undefined): Uint8Array | undefined {
    if (!response || !(response.statusCode >= 200 && response.statusCode < 300)) return undefined
    return response.body
  }

  /** Writes run one at a time, so `stopRenewals` can wait out whichever is underway. */
  async replaceCredential(credential: AccountCredential): Promise<void> {
    if (this.renewalsStopped) return
    const previous = this.credentialWrite
    const write = (async (): Promise<void> => {
      if (previous) await previous.catch(() => undefined)
      await this.vault.update(credential, this.account.id)
    })()
    this.credentialWrite = write
    await write
    if (credential.type === 'oauth' && credential.tokens.accessToken === this.unsavedRenewal?.accessToken) this.unsavedRenewal = undefined
  }

  earlyRenewalIsHeld(expiresAt: Instant): boolean {
    return expiresAt > this.now() && this.now() < this.earlyRenewalNotBefore
  }

  holdEarlyRenewal(error: unknown): void {
    if (!ProviderError.is(error, 'rateLimited') || error.case.retryAfter === undefined) return
    this.earlyRenewalNotBefore = addSeconds(this.now(), error.case.retryAfter)
  }

  /**
   * Lets a renewal or write that's underway finish, and saves nothing after it, so neither can overwrite
   * the sign-in replacing this runtime. `resumeRenewals` undoes it if the replacement doesn't go through.
   */
  async stopRenewals(): Promise<void> {
    this.renewalsStopped = true
    await this.renewal?.catch(() => undefined)
    await this.credentialWrite?.catch(() => undefined)
  }

  /** Moves a runtime that proved a new sign-in onto the store that now holds it. */
  adopt(vault: CredentialVault): void {
    this.vault = vault
    this.isCheckingNewSignIn = false
  }

  resumeRenewals(): void {
    this.renewalsStopped = false
  }

  async saveRenewal(tokens: OAuthTokens): Promise<void> {
    this.unsavedRenewal = tokens
    try {
      await this.replaceCredential(AccountCredential.oauth(tokens))
    } catch (error) {
      AppLog.error('auth', `${this.cardID} couldn't save the renewed sign-in; keeping it and retrying: ${describeError(error)}`)
    }
  }

  async readSnapshot(credential: AccountCredential): Promise<ProviderSnapshot> {
    const usage = await this.readUsage(credential)
    const snapshot = ProviderSnapshot.forProvider(this.provider, usage.plan, [...usage.lines], usage.notice)
    if (usage.lineTitles && Object.keys(usage.lineTitles).length > 0) snapshot.lineTitles = usage.lineTitles
    HistoryRow.append(snapshot, this.widgetDescriptors, usage.history)
    return snapshot
  }
}
