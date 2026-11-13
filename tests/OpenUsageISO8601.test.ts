import { describe, expect, it } from 'vitest'
import { OpenUsageISO8601 } from '@core/support/OpenUsageISO8601'

describe('OpenUsageISO8601Tests', () => {
  it('normalizesMicrosecondsWithoutTimezoneLikeClaudeAPI', () => {
    const date = OpenUsageISO8601.date('2099-01-01T00:00:00.123456')
    expect(date).toBeDefined()
    expect(OpenUsageISO8601.string(date!)).toBe('2099-01-01T00:00:00.123Z')
  })

  it('normalizesSpaceSeparatedUTC', () => {
    const date = OpenUsageISO8601.date('2099-01-01 00:00:00 UTC')
    expect(date).toBeDefined()
  })
})
