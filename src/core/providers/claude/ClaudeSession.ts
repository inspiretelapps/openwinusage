import type { HTTPResponse } from '../../services/HTTPClient'
import { RefreshBackoff } from '../../stores/RefreshBackoff'
import type { Defaults } from '../../support/Defaults'
import { isJSONObject } from '../../support/ProviderParse'
import { addSeconds, secondsBetween, type Instant, type Seconds } from '../../support/time'
import { ProviderError } from '../ProviderError'
import { SecondaryRead } from '../SecondaryRead'
import { ClaudeResetGrantsState } from './AccountProviderRuntime+ClaudeResets'

/**
 * A Claude login's 429 window. Anthropic budgets its usage endpoint per account (about 30 requests an
 * hour, shared with Claude Code and every other monitor on it) and holds a penalty on its own side for
 * up to an hour, so the window outlives a relaunch and nothing goes to the account inside it.
 */
export interface ClaudeRateLimitWindow {
  until: Instant
  strikes: number
}

function sameWindow(a: ClaudeRateLimitWindow | undefined, b: ClaudeRateLimitWindow | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  return a.until === b.until && a.strikes === b.strikes
}

export class ClaudeSession {
  /** Changed by `ClaudeSessions.rekey` only. */
  key: string
  private readonly sessions: ClaudeSessions
  private usageInFlight: Promise<HTTPResponse> | undefined
  resetGrants = new ClaudeResetGrantsState()
  planRead = new SecondaryRead<string>()
  organizationUUID: string | undefined

  /** Made by `ClaudeSessions.session(key)` only. */
  constructor(key: string, sessions: ClaudeSessions) {
    this.key = key
    this.sessions = sessions
  }

  wait(now: Instant): Seconds | undefined {
    const until = this.sessions.window(this.key)?.until
    if (until === undefined || !(now < until)) return undefined
    return secondsBetween(until, now)
  }

  async send(now: Instant, request: () => Promise<HTTPResponse>): Promise<HTTPResponse> {
    const held = this.wait(now)
    if (held !== undefined) throw ProviderError.rateLimited(held)
    const window = this.sessions.window(this.key)
    const response = await request()
    if (response.statusCode === 429) {
      const strikes = (this.sessions.window(this.key)?.strikes ?? 0) + 1
      const wait = Math.max(response.retryAfter(now) ?? 0, RefreshBackoff.delay(strikes))
      this.sessions.setWindow({ until: addSeconds(now, wait), strikes }, this.key)
      throw ProviderError.rateLimited(wait)
    }
    if (response.statusCode >= 200 && response.statusCode < 300 && sameWindow(this.sessions.window(this.key), window)) {
      this.sessions.setWindow(undefined, this.key)
    }
    return response
  }

  async usage(now: Instant, request: () => Promise<HTTPResponse>): Promise<HTTPResponse> {
    if (this.usageInFlight) return this.usageInFlight
    const task = this.send(now, request)
    this.usageInFlight = task
    try {
      return await task
    } finally {
      this.usageInFlight = undefined
    }
  }
}

export class ClaudeSessions {
  static readonly storageKey = 'openusage.claudeRateLimits.v1'
  private readonly defaults: Defaults | undefined
  private sessions = new Map<string, ClaudeSession>()
  private windows: Map<string, ClaudeRateLimitWindow>

  constructor(defaults?: Defaults) {
    this.defaults = defaults
    this.windows = ClaudeSessions.decode(defaults?.get(ClaudeSessions.storageKey))
  }

  session(key: string): ClaudeSession {
    const existing = this.sessions.get(key)
    if (existing) return existing
    const session = new ClaudeSession(key, this)
    this.sessions.set(key, session)
    return session
  }

  rekey(session: ClaudeSession, identity: string): void {
    if (session.key === identity || this.sessions.has(identity)) return
    this.sessions.delete(session.key)
    this.setWindow(undefined, session.key)
    session.key = identity
    this.sessions.set(identity, session)
  }

  /** A login's window. For this file's sessions only (`fileprivate` upstream). */
  window(key: string): ClaudeRateLimitWindow | undefined {
    return this.windows.get(key)
  }

  /** Sets or clears a login's window and saves them all. For this file's sessions only (`fileprivate` upstream). */
  setWindow(window: ClaudeRateLimitWindow | undefined, key: string): void {
    if (sameWindow(this.windows.get(key), window)) return
    if (window === undefined) this.windows.delete(key)
    else this.windows.set(key, window)
    const stored: Record<string, ClaudeRateLimitWindow> = {}
    for (const [name, value] of this.windows) stored[name] = { until: value.until, strikes: value.strikes }
    this.defaults?.set(ClaudeSessions.storageKey, stored)
  }

  /** The stored windows, or none when any of them is malformed. */
  private static decode(stored: unknown): Map<string, ClaudeRateLimitWindow> {
    const windows = new Map<string, ClaudeRateLimitWindow>()
    if (!isJSONObject(stored)) return windows
    for (const [key, value] of Object.entries(stored)) {
      if (!isJSONObject(value)) return new Map()
      const { until, strikes } = value
      if (typeof until !== 'number' || !Number.isFinite(until) || typeof strikes !== 'number' || !Number.isInteger(strikes)) return new Map()
      windows.set(key, { until, strikes })
    }
    return windows
  }
}
