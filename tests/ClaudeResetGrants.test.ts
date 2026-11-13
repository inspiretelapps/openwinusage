import { describe, expect, it } from 'vitest'
import type { MetricLine } from '@core/models/MetricLine'
import { ProviderError } from '@core/providers/ProviderError'
import { ClaudeResetGrantStatus } from '@core/providers/claude/ClaudeResetGrantStatus'
import { ClaudeUsageClient } from '@core/providers/claude/ClaudeUsageClient'
import { ClaudeUsageMapper } from '@core/providers/claude/ClaudeUsageMapper'
import { OpenUsageISO8601 } from '@core/support/OpenUsageISO8601'
import type { Instant } from '@core/support/time'
import { jsonResponse, RoutingHTTPClient, unix } from './TestSupport'

/**
 * The Claude "Rate Limit Resets" row, read from the reset-grants response's `cedar_ember` block
 * (Anthropic's one-off usage-limit reset grants).
 */
describe('ClaudeResetGrantsTests', () => {
  const now = unix(1_790_000_000)

  function resetsLine(json: string): MetricLine | undefined {
    const status = ClaudeUsageMapper.mapResetGrantStatus(jsonResponse(json))
    return status === undefined ? undefined : ClaudeResetGrantStatus.line(status, now)
  }

  function countAndExpiries(line: MetricLine | undefined): { count: number | undefined; expiries: Instant[] } {
    if (line?.type !== 'values') throw new Error('expected the resets row')
    return { count: line.values[0]?.number, expiries: line.expiriesAt }
  }

  function date(text: string): Instant {
    const parsed = OpenUsageISO8601.date(text)
    if (parsed === undefined) throw new Error(`bad fixture date: ${text}`)
    return parsed
  }

  it('testMapsEachRemainingResetWithItsGrantDeadline', () => {
    const line = resetsLine(`
        { "cedar_ember": {
            "eligible": true, "at_limit": false, "exhausted": [],
            "grants": [
              { "id": "opus55-launch-promax-20260921", "resets_total": 1, "resets_left": 1,
                "starts_at": "2026-09-22T16:00:00+00:00", "ends_at": "2026-10-22T16:00:00+00:00",
                "clears": ["five_hour", "seven_day"], "paused": false, "usable_now": true },
              { "id": "other", "resets_total": 2, "resets_left": 2, "ends_at": "2026-10-01T00:00:00+00:00" },
              { "id": "spent", "resets_total": 1, "resets_left": 0, "ends_at": "2026-10-05T00:00:00+00:00" },
              { "id": "lapsed", "resets_total": 1, "resets_left": 1, "ends_at": "2026-09-01T00:00:00+00:00" }
            ],
            "next_grant_id": "opus55-launch-promax-20260921" } }
        `)

    const { count, expiries } = countAndExpiries(line)
    expect(count).toBe(3)
    expect(expiries).toEqual([date('2026-10-01T00:00:00+00:00'), date('2026-10-01T00:00:00+00:00'), date('2026-10-22T16:00:00+00:00')])
  })

  it('testGrantWithoutDeadlineCountsWithNoExpiry', () => {
    const line = resetsLine('{"cedar_ember":{"eligible":true,"grants":[{"id":"g","resets_left":1,"ends_at":null}]}}')
    const { count, expiries } = countAndExpiries(line)
    expect(count).toBe(1)
    expect(expiries).toEqual([])
  })

  it('testIneligibleAccountReadsZeroAvailable', () => {
    const line = resetsLine('{"cedar_ember":{"eligible":false,"ineligible_reason":"tier","grants":[{"id":"g","resets_left":1}]}}')
    const { count, expiries } = countAndExpiries(line)
    expect(count).toBe(0)
    expect(expiries).toEqual([])
  })

  it('testMissingOrNullBlockEmitsNoRow', () => {
    expect(resetsLine('{"cedar_ember":null}')).toBeUndefined()
    expect(resetsLine('{"five_hour":{"utilization":3}}')).toBeUndefined()
  })

  it('testAGrantCountTooLargeForAnIntDropsTheBlock', () => {
    expect(ClaudeResetGrantStatus.parse({ eligible: true, grants: [{ id: 'g', resets_left: 1e300 }] })).toBeUndefined()
  })

  it('testAnUnreadableCheckThrows', () => {
    let thrown: unknown
    try {
      resetsLine('not json')
    } catch (error) {
      thrown = error
    }
    expect(ProviderError.invalidResponse.equals(thrown)).toBe(true)
  })

  it('testResetGrantsRequestIdentifiesAsClaudeCode', async () => {
    // Anthropic gates reset grants by client surface: an unrecognized User-Agent comes back
    // `eligible: false, ineligible_reason: "surface"` with no grants.
    const http = new RoutingHTTPClient(() => jsonResponse('{}'))
    await new ClaudeUsageClient(http).fetchResetGrants('token')
    const request = http.requests[0]
    expect(request).toBeDefined()
    expect(request.url).toBe('https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1')
    expect(request.headers?.['Authorization']).toBe('Bearer token')
    const userAgent = request.headers?.['User-Agent']
    expect(userAgent).toBeDefined()
    expect(userAgent?.startsWith('claude-cli/'), userAgent).toBe(true)
    expect(userAgent?.endsWith('(external, cli)'), userAgent).toBe(true)
  })

  // Reads the popover's entries from `RateLimitResetsDetail`, a view (`Views/`), which is outside the providers.
  it.todo('testPopoverEntriesStayDistinctWhenResetsShareADeadline')
})
