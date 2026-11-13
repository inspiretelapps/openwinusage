import { describe, expect, it } from 'vitest'
import { AccountInitials } from '@core/models/AccountInitials'

describe('AccountInitialsTests', () => {
  it('testTagIsTheFirstLetterOfTheFirstAndLastWord', () => {
    expect(AccountInitials.tag('Attention Machine 1')).toBe('A1')
    expect(AccountInitials.tag('rob@sunstory.com')).toBe('R')
    expect(AccountInitials.tag('Personal')).toBe('P')
    expect(AccountInitials.tag('  side   project  ')).toBe('SP')
    expect(AccountInitials.tag('')).toBe('')
  })

  // testEveryAccountOfAProviderWithSeveralCarriesItsInitials needs `WidgetRegistry` (Stores), not ported yet.
})
