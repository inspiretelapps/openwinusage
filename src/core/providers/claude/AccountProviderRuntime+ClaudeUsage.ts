import { AccountCredential, OAuthTokens } from '../../models/Account'
import type { MetricLine } from '../../models/MetricLine'
import { ProviderSnapshot } from '../../models/ProviderSnapshot'
import { ClaudeLogin } from '../../services/BrowserProviderLogins'
import { RefreshSetting } from '../../stores/RefreshSetting'
import { AppLog, describeError, LogTags } from '../../support/AppLog'
import type { AccountProviderRuntime } from '../AccountProviderRuntime'
import { ProviderError } from '../ProviderError'
import { ProviderUsage } from '../ProviderRuntime'
import { readClaudeResetGrants } from './AccountProviderRuntime+ClaudeResets'
import { ClaudeResetGrantStatus } from './ClaudeResetGrantStatus'
import type { ClaudeSession, ClaudeSessions } from './ClaudeSession'
import { ClaudeAccountProfile, ClaudeUsageClient } from './ClaudeUsageClient'
import { ClaudeUsageMapper } from './ClaudeUsageMapper'

export class ClaudeAccountState {
  readonly sessions: ClaudeSessions
  session: ClaudeSession | undefined
  forcedReadsPending = false
  restoredPlan: string | undefined
  restoredResets: MetricLine | undefined

  constructor(sessions: ClaudeSessions) {
    this.sessions = sessions
  }
}

/**
 * One usage read per pass, shared with any other card on the same login and never sent inside its
 * 429 window. The profile and the reset grants are read in the secondary-reads slot instead, apart
 * from it: Anthropic answers a grants read sent right after a usage read with a 429. A hub account
 * reads its profile with its first usage read, so it shows its plan as soon as it appears.
 */
export async function refreshClaude(rt: AccountProviderRuntime, credential: AccountCredential): Promise<ProviderUsage> {
  const session = claudeSession(rt, credential)
  const forced = rt.claude.forcedReadsPending
  rt.claude.forcedReadsPending = false
  const wait = session.wait(rt.now())
  if (wait !== undefined) throw ProviderError.rateLimited(wait)
  const client = new ClaudeUsageClient(rt.http)
  const { tokens, response } = await rt.authorizedRead(credential, ClaudeLogin.refresh, (tokens) => {
    const request = () => client.fetchUsage(tokens.accessToken)
    // Cards on one login share a request to save its budget, but a new sign-in must prove itself.
    return rt.isCheckingNewSignIn ? session.send(rt.now(), request) : session.usage(rt.now(), request)
  })
  const lines = ClaudeUsageMapper.mapUsageResponse(response)
  if (forced) {
    if (session.resetGrants.isOlder(RefreshSetting.forcedResetGrantsMinimumAge, rt.now())) {
      await readClaudeResetGrants(rt, session, tokens.accessToken)
    }
    await readClaudeProfile(rt, session, tokens).catch(() => undefined)
  } else if (rt.account.hub !== undefined && session.planRead.value === undefined && session.planRead.isDue(rt.now())) {
    await readClaudeProfile(rt, session, tokens).catch(() => undefined)
  }
  const resets = claudeResetsLine(rt, session)
  if (resets) lines.push(resets)
  const plan = session.planRead.value
  const usage = ProviderUsage.make(plan, lines)
  usage.lineTitles = ClaudeUsageMapper.lineTitles(plan)
  return usage
}

export function restoreClaude(rt: AccountProviderRuntime, snapshot: ProviderSnapshot): void {
  rt.claude.restoredPlan = snapshot.plan
  rt.claude.restoredResets = ProviderSnapshot.line(snapshot, ClaudeResetGrantStatus.lineLabel)
}

/** Upstream's `refreshHourlyReads(of:)`, which only a Claude account answers. */
export async function refreshClaudeHourlyReads(rt: AccountProviderRuntime, snapshot: ProviderSnapshot): Promise<ProviderSnapshot | undefined> {
  if (rt.account.kind !== 'claude') return undefined
  const launched = rt.claude.session === undefined ? await rt.loadCredential().catch(() => undefined) : undefined
  const session = rt.claude.session ?? (launched === undefined ? undefined : claudeSession(rt, launched))
  if (!session) return undefined
  const profileDue = session.planRead.isDue(rt.now())
  const grantsDue = session.resetGrants.isOlder(RefreshSetting.secondaryReadInterval, rt.now())
  if (!(profileDue || grantsDue) || session.wait(rt.now()) !== undefined) return undefined
  let tokens: OAuthTokens
  try {
    tokens = await rt.freshTokens(await rt.loadCredential(), ClaudeLogin.refresh)
  } catch {
    return undefined
  }
  if (profileDue) await readClaudeProfile(rt, session, tokens).catch(() => undefined)
  if (grantsDue) await readClaudeResetGrants(rt, session, tokens.accessToken)
  const updated: ProviderSnapshot = { ...snapshot, lines: snapshot.lines.filter((line) => line.label !== ClaudeResetGrantStatus.lineLabel) }
  const plan = session.planRead.value
  if (plan === undefined) delete updated.plan
  else updated.plan = plan
  const titles = ClaudeUsageMapper.lineTitles(updated.plan)
  if (Object.keys(titles).length === 0) delete updated.lineTitles
  else updated.lineTitles = titles
  const resets = claudeResetsLine(rt, session)
  if (resets) updated.lines.push(resets)
  // Only the plan, the titles, and the lines can differ from `snapshot`.
  const unchanged =
    updated.plan === snapshot.plan && sameValue(updated.lineTitles, snapshot.lineTitles) && sameValue(updated.lines, snapshot.lines)
  return unchanged ? undefined : updated
}

export async function readClaudeProfile(rt: AccountProviderRuntime, session: ClaudeSession, tokens: OAuthTokens): Promise<void> {
  try {
    const client = new ClaudeUsageClient(rt.http)
    const response = await session.send(rt.now(), () => client.fetchProfile(tokens.accessToken))
    if (ProviderError.isAuthFailure(response)) throw ProviderError.signInExpired('claude')
    const profile = ClaudeUsageClient.decodeProfile(response)
    if (tokens.extras[OAuthTokens.identityKey] === undefined) {
      const stored = await rt.loadCredential().catch(() => undefined)
      if (stored?.type === 'oauth') {
        const identified: OAuthTokens = {
          ...stored.tokens,
          extras: { ...stored.tokens.extras, [OAuthTokens.identityKey]: ClaudeAccountProfile.identity(profile) }
        }
        await rt.replaceCredential(AccountCredential.oauth(identified)).catch(() => undefined)
      }
      rt.claude.sessions.rekey(session, ClaudeAccountProfile.identity(profile))
    }
    const uuid = profile.organization?.uuid
    if (uuid !== undefined && isUUID(uuid)) session.organizationUUID = uuid
    session.planRead.record(ClaudeUsageMapper.formatLivePlan(profile), rt.now())
  } catch (error) {
    // Upstream rethrows without recording when the read was cancelled; a read here is never cancelled.
    AppLog.warn(LogTags.plugin('claude'), `plan lookup failed; retrying in an hour: ${describeError(error)}`)
    session.planRead.record(undefined, rt.now())
    throw error
  }
}

function claudeSession(rt: AccountProviderRuntime, credential: AccountCredential): ClaudeSession {
  const session = rt.claude.sessions.session(AccountCredential.identity(credential) ?? `card:${rt.cardID}`)
  const plan = rt.claude.restoredPlan
  if (session.planRead.value === undefined && plan !== undefined) {
    session.planRead.record(plan, rt.now())
    session.planRead.forget()
  }
  rt.claude.session = session
  return session
}

function claudeResetsLine(rt: AccountProviderRuntime, session: ClaudeSession): MetricLine | undefined {
  const check = session.resetGrants.check
  if (!check) return rt.claude.restoredResets
  return check.status === undefined ? undefined : ClaudeResetGrantStatus.line(check.status, rt.now())
}

/** `UUID(uuidString:) != nil` */
function isUUID(text: string): boolean {
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(text)
}

/** Whether two plain JSON values are equal, an absent field being the same as an undefined one. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => sameValue(item, b[index]))
  }
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    if (!sameValue(left[key], right[key])) return false
  }
  return true
}
