import { describe, expect, it } from 'vitest'
import { ClaudeAccountProfile } from '@core/providers/claude/ClaudeUsageClient'
import { ClaudeUsageMapper } from '@core/providers/claude/ClaudeUsageMapper'

/** Anthropic renamed Max 5x to Max and Max 20x to Ultra on Oct 30, 2026 (#1497). */
describe('ClaudePlanTests', () => {
  function plan(organizationType: string, rateLimitTier: string | undefined): string | undefined {
    const tier = rateLimitTier === undefined ? '' : `,"rate_limit_tier":"${rateLimitTier}"`
    const json = `{"account":{"uuid":"acc-1"},"organization":{"uuid":"org-1","organization_type":"${organizationType}"${tier}}}`
    const profile = ClaudeAccountProfile.decode(json)
    if (!profile) throw new Error('the profile did not decode')
    return ClaudeUsageMapper.formatLivePlan(profile)
  }

  it('testMaxTiersReadUnderAnthropicsNewPlanNames', () => {
    expect(plan('claude_max', 'default_claude_max_5x')).toBe('Max')
    expect(plan('claude_max', 'default_claude_max_20x')).toBe('Ultra')
    expect(plan('claude_max', undefined)).toBe('Max')
  })

  it('testAnUltraTierOrOrganizationReadsUltra', () => {
    expect(plan('claude_max', 'default_claude_ultra')).toBe('Ultra')
    expect(plan('claude_ultra', 'default_claude_ultra')).toBe('Ultra')
    expect(plan('claude_ultra', 'default_claude_max_20x')).toBe('Ultra')
  })

  it('testOtherPlansKeepTheirNames', () => {
    expect(plan('claude_pro', 'default_claude_ai')).toBe('Pro')
    expect(plan('claude_team', 'default_claude_max_5x')).toBe('Team 5x')
    expect(plan('claude_enterprise', undefined)).toBe('Enterprise')
  })
})
