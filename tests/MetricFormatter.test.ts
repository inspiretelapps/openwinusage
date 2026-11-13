import { describe, expect, it } from 'vitest'
import { metricValue } from '@core/models/MetricValue'
import { MetricFormatter } from '@core/support/MetricFormatter'

describe('MetricFormatterTests', () => {
  it('testDollarsAbbreviateAboveAThousandPerStyle', () => {
    expect(MetricFormatter.number(0, 'dollars', 'tray')).toBe('$0')
    expect(MetricFormatter.number(0.25, 'dollars', 'tray')).toBe('$0.25')
    expect(MetricFormatter.number(129.81, 'dollars', 'tray')).toBe('$130')
    expect(MetricFormatter.number(2059.07, 'dollars', 'tray')).toBe('$2.1K')
    expect(MetricFormatter.number(40.76, 'dollars', 'row')).toBe('$40.76')
    expect(MetricFormatter.number(2059.07, 'dollars', 'row')).toBe('$2.1K')
  })

  it('testCountsAbbreviateInTrayAndRow', () => {
    expect(MetricFormatter.number(56_904_995, 'count', 'tray')).toBe('56.9M')
    expect(MetricFormatter.number(56_904_995, 'count', 'row')).toBe('56.9M')
    expect(MetricFormatter.number(1_485_201_513, 'count', 'row')).toBe('1.5B')
    expect(MetricFormatter.number(820.6, 'count', 'row')).toBe('820.6')
  })

  it('testPercentRoundsToWholeInEveryStyle', () => {
    expect(MetricFormatter.number(95, 'percent', 'row')).toBe('95%')
    expect(MetricFormatter.number(95.4, 'percent', 'tray')).toBe('95%')
  })

  it('testPercentClampsOutOfRangeSamples', () => {
    expect(MetricFormatter.number(-5, 'percent', 'row')).toBe('0%')
    expect(MetricFormatter.number(130, 'percent', 'tray')).toBe('100%')
  })

  it('testValueStringAppendsUnitLabelWhenPresent', () => {
    const credits = metricValue(772, 'count', 'credits')
    expect(MetricFormatter.string(credits, 'row')).toBe('772 credits')
    const tokens = metricValue(56_904_995, 'count')
    expect(MetricFormatter.string(tokens, 'tray')).toBe('56.9M')
  })

  // Not upstream cases. Each expected string is what `MetricFormatter.swift` printed for the same input
  // when run against Foundation (macOS 27, Swift 6.4), so the `Intl` options stay matched to it.
  describe('Foundation parity', () => {
    it('rounds ties to even, as Foundation format styles do', () => {
      const counts: [number, string][] = [
        [0.5, '0.5'], [0.25, '0.2'], [0.35, '0.4'], [0.45, '0.4'], [0.05, '0'], [0.15, '0.2'], [-0.04, '-0'],
        [999.4, '999.4'], [999.95, '1,000'], [1250, '1.2K'], [1350, '1.4K'], [1050, '1K'], [999_950, '1M'],
        [1.25e9, '1.2B'], [1e12, '1T'], [1.5e15, '1500T'], [-1250, '-1.2K'], [12345.678, '12.3K']
      ]
      for (const [value, text] of counts) expect(MetricFormatter.number(value, 'count', 'row'), `${value}`).toBe(text)
    })

    it('shows a tray amount whole, or to the cent under a dollar', () => {
      const amounts: [number, string][] = [
        [0.005, '$0.00'], [0.015, '$0.02'], [0.995, '$1.00'], [2.5, '$2'], [3.5, '$4'], [999.5, '$1,000'],
        [-0.25, '$-0.25'], [-5, '$-5'], [-2059.07, '$-2.1K']
      ]
      for (const [value, text] of amounts) expect(MetricFormatter.number(value, 'dollars', 'tray'), `${value}`).toBe(text)
    })

    it('shows a row amount with cents unless it is a whole number of dollars', () => {
      const amounts: [number, string][] = [
        [0, '$0'], [12, '$12'], [12.5, '$12.50'], [0.4, '$0.40'], [999.99, '$999.99'], [999.999, '$1,000'],
        [-12.5, '-$12.50'], [0.125, '$0.12'], [0.015, '$0.02'], [1.005, '$1'], [0.004, '$0'], [12.996, '$13'],
        [315.28, '$315.28']
      ]
      for (const [value, text] of amounts) expect(MetricFormatter.number(value, 'dollars', 'row'), `${value}`).toBe(text)
    })

    it('uses the symbol en_US shows for a currency code, and the code itself where it has none', () => {
      expect(MetricFormatter.number(12.5, 'dollars', 'row', 'EUR')).toBe('€12.50')
      expect(MetricFormatter.number(12.5, 'dollars', 'tray', 'EUR')).toBe('€12')
      expect(MetricFormatter.number(2059.07, 'dollars', 'row', 'GBP')).toBe('£2.1K')
      expect(MetricFormatter.number(5, 'dollars', 'row', 'CAD')).toBe('CA$5')
      expect(MetricFormatter.number(12.5, 'dollars', 'row', 'JPY')).toBe('¥12.50')
      expect(MetricFormatter.number(12.5, 'dollars', 'row', 'ZAR')).toBe('ZAR\u00a012.50')
      expect(MetricFormatter.number(12.5, 'dollars', 'tray', 'ZAR')).toBe('ZAR12')
      expect(MetricFormatter.number(2059.07, 'dollars', 'row', 'CHF')).toBe('CHF2.1K')
      expect(MetricFormatter.number(5, 'dollars', 'row', 'ZZZ')).toBe('ZZZ\u00a05')
      expect(MetricFormatter.number(12.5, 'dollars', 'row', 'usd')).toBe('$12.50')
    })
  })
})
