import { describe, expect, it } from 'vitest'
import { UsageBreakdown, UsageHistory, UsageTotals, UsageWindow, type UsageMeasure } from '@core/models/UsageHistory'
import { Calendar } from '@core/support/Calendar'

describe('UsageBreakdownDetailTests', () => {
  function breakdown(values: Partial<Record<UsageMeasure, number>>): UsageBreakdown {
    const history = UsageHistory.make(Calendar.current, Date.now())
    history.days.set(Calendar.current.startOfDay(Date.now()), { totals: UsageTotals.make(values) })
    return UsageBreakdown.make(UsageWindow.today, history)
  }

  // testTheWidestTokenLegendFitsInsideThePopover and testTheEmptyMessageWrapsOntoBalancedLines measure and
  // render SwiftUI views: no port.

  it('testOnlyARangeOfZerosIsEmpty', () => {
    const zeros = breakdown({ credits: 0, tokens: 0 })
    expect(UsageBreakdown.isEmpty(zeros)).toBe(true)

    const spendOnly = breakdown({ spend: 0, byokSpend: 0 })
    expect(UsageBreakdown.isEmpty(spendOnly), 'a zero charge and nothing else leaves nothing to show').toBe(true)

    const totals = breakdown({ credits: 0, tokens: 766_600_000 })
    expect(UsageBreakdown.isEmpty(totals), 'tokens without a charge are still usage').toBe(false)
  })

  // The model half of testTheWidestTokenLegendFitsInsideThePopover: what that legend reads.
  it('the widest token legend reads its parts largest first, with the figures the popover shows', () => {
    const wide = breakdown({
      spend: 857.56,
      tokens: 991.9e6 * 5,
      inputTokens: 824.2e6,
      cacheReadTokens: 999.9e6,
      cacheWriteTokens: 891.9e6,
      outputTokens: 793.6e6,
      reasoningTokens: 693.6e6
    })
    expect(UsageBreakdown.figures(wide)).toEqual(['$857.56', '5B tokens'])
    expect(UsageBreakdown.tokenParts(wide).map((part) => part.title)).toEqual(['Cache Read', 'Cache Write', 'Input', 'Output', 'Reasoning'])
    expect(UsageBreakdown.tokenPartsFillTotal(wide)).toBe(false)
  })
})
