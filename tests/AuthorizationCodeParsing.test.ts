import { describe, it, expect } from 'vitest'
import { AuthorizationInput, LoginError, authorizationCode } from '@core/services/OAuthLoginSupport'

describe('AuthorizationCodeParsingTests', () => {
  it('testAPastedCodeWithItsStateIsAccepted', () => {
    expect(authorizationCode(AuthorizationInput.pasted('abc123#expected'), 'expected')).toBe('abc123')
    expect(authorizationCode(AuthorizationInput.pasted('  abc123#expected\n'), 'expected')).toBe('abc123')
  })

  it('testAPastedCodeWithTheWrongOrAMissingStateIsRefused', () => {
    expect(() => authorizationCode(AuthorizationInput.pasted('abc123#other'), 'expected')).toThrow(LoginError.invalidState.message)
    expect(() => authorizationCode(AuthorizationInput.pasted('abc123'), 'expected')).toThrow(LoginError.invalidState.message)
  })

  it('testABlankPasteIsAnInvalidCode', () => {
    expect(() => authorizationCode(AuthorizationInput.pasted('   '), 'expected')).toThrow(LoginError.invalidCode.message)
  })

  it('testAWholeCallbackURLIsReadForItsCodeAndState', () => {
    const callback = 'http://127.0.0.1:1455/auth/callback?code=abc123&state=expected'
    expect(authorizationCode(AuthorizationInput.pasted(callback), 'expected')).toBe('abc123')
    expect(() =>
      authorizationCode(AuthorizationInput.pasted('http://127.0.0.1:1455/auth/callback?code=abc123&state=other'), 'expected')
    ).toThrow(LoginError.invalidState.message)
    expect(() => authorizationCode(AuthorizationInput.pasted('http://127.0.0.1:1455/auth/callback'), 'expected')).toThrow(
      LoginError.invalidCode.message
    )
  })
})
