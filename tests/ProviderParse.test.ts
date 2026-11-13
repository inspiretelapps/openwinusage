import { describe, expect, it } from 'vitest'
import { ProviderParse, urlFormEncoded, utf8 } from '@core/support/ProviderParse'

describe('ProviderParseTests', () => {
  it('testURLFormEncodingPreservesOnlyRFC3986UnreservedASCII', () => {
    expect(urlFormEncoded('AZaz09-._~')).toBe('AZaz09-._~')
    expect(urlFormEncoded('space & equals= plus+ slash/ question? percent%')).toBe(
      'space%20%26%20equals%3D%20plus%2B%20slash%2F%20question%3F%20percent%25'
    )
    expect(urlFormEncoded('café')).toBe('caf%C3%A9')
  })

  it('testNumberDistinguishesJSONBooleansFromNumbers', () => {
    const object = ProviderParse.jsonObject(utf8('{"true":true,"false":false,"one":1,"zero":0,"decimal":1.5,"string":" 2.5 "}'))
    expect(object).toBeDefined()

    expect(ProviderParse.number(object!['true'])).toBeUndefined()
    expect(ProviderParse.number(object!['false'])).toBeUndefined()
    expect(ProviderParse.number(object!['one'])).toBe(1)
    expect(ProviderParse.number(object!['zero'])).toBe(0)
    expect(ProviderParse.number(object!['decimal'])).toBe(1.5)
    expect(ProviderParse.number(object!['string'])).toBe(2.5)
    expect(ProviderParse.bool(object!['true'])).toBe(true)
  })
})
