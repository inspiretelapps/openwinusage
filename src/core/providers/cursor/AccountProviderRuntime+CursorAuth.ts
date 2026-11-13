import { AccountCredential, type OAuthTokens } from '../../models/Account'
import { OAuthTokenResponse } from '../../services/OAuthLoginSupport'
import { AppLog, describeError, LogTags } from '../../support/AppLog'
import { ProviderParse } from '../../support/ProviderParse'
import { addSeconds, type Seconds } from '../../support/time'
import type { AccountProviderRuntime } from '../AccountProviderRuntime'
import { ProviderError } from '../ProviderError'
import { CursorUsageClient } from './CursorUsageClient'
import { asBool } from './CursorUsageEvents'

/**
 * Cursor's access token is a 60-day JWT that is also its refresh token, so the sign-in dies at that
 * JWT's `exp`. Refreshing a week early keeps the account alive when the computer is off around expiry.
 */
export const cursorRefreshLead: Seconds = 7 * 86_400

export async function cursorTokens(rt: AccountProviderRuntime, credential: AccountCredential): Promise<OAuthTokens> {
  if (credential.type !== 'oauth') throw ProviderError.invalidResponse
  const tokens: OAuthTokens = { ...credential.tokens, extras: { ...credential.tokens.extras } }
  const hadExpiry = tokens.expiresAt !== undefined
  const expiresAt = tokens.expiresAt ?? ProviderParse.jwtExpiry(tokens.accessToken)
  if (expiresAt === undefined) return tokens
  tokens.expiresAt = expiresAt
  if (addSeconds(expiresAt, -cursorRefreshLead) <= rt.now() && !rt.earlyRenewalIsHeld(expiresAt)) {
    try {
      return await refreshCursorTokens(rt, tokens)
    } catch (error) {
      if (!(expiresAt > rt.now())) throw error
      rt.holdEarlyRenewal(error)
      AppLog.warn(LogTags.plugin('cursor'), `${rt.cardID} early token refresh failed; keeping the current token: ${describeError(error)}`)
    }
  }
  if (!hadExpiry) await rt.replaceCredential(AccountCredential.oauth(tokens))
  return tokens
}

/**
 * Trades the refresh token at `/oauth/token` for a new 60-day access token and saves it. Cursor
 * answers with `access_token` and no `refresh_token`. The new JWT then works as the next refresh
 * token, the same way the login poll pairs them. `shouldLogout` means Cursor ended the session.
 */
export async function refreshCursorTokens(rt: AccountProviderRuntime, tokens: OAuthTokens): Promise<OAuthTokens> {
  const refreshToken = tokens.refreshToken
  if (refreshToken === undefined) throw ProviderError.signInExpired('cursor')
  const response = await new CursorUsageClient(rt.http).refreshToken(refreshToken)
  if (asBool(ProviderParse.jsonObject(response.body)?.shouldLogout) === true) throw ProviderError.signInExpired('cursor')
  const token = OAuthTokenResponse.renewal(response, 'cursor')
  const refreshed: OAuthTokens = { ...tokens, extras: { ...tokens.extras } }
  refreshed.accessToken = token.accessToken
  refreshed.refreshToken = token.refreshToken ?? token.accessToken
  const expiresAt = ProviderParse.jwtExpiry(token.accessToken)
  if (expiresAt === undefined) delete refreshed.expiresAt
  else refreshed.expiresAt = expiresAt
  await rt.saveRenewal(refreshed)
  return refreshed
}
