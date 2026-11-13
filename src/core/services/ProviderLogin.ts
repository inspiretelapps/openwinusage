import type { AccountCredential } from '../models/Account'

export type LoginPrompt =
  | { type: 'browser'; url: string; acceptsPastedCode: boolean }
  /** The page shows a token for the user to paste into the sheet. Nothing comes back to the app on its own. */
  | { type: 'browserToken'; url: string }
  | { type: 'deviceCode'; userCode: string; verificationURL: string }

export const LoginPrompt = {
  browser(url: string, acceptsPastedCode: boolean): LoginPrompt {
    return { type: 'browser', url, acceptsPastedCode }
  },

  browserToken(url: string): LoginPrompt {
    return { type: 'browserToken', url }
  },

  deviceCode(userCode: string, verificationURL: string): LoginPrompt {
    return { type: 'deviceCode', userCode, verificationURL }
  }
}

export interface ProviderLogin {
  /**
   * `pastedCode` yields each code or token the user pastes into the sheet. Aborting `signal` is the
   * port of cancelling the login's task: the login stops and rejects with `LoginError.cancelled`.
   */
  login(
    prompt: (prompt: LoginPrompt) => Promise<void> | void,
    pastedCode: AsyncIterable<string>,
    signal?: AbortSignal
  ): Promise<{ label: string; credential: AccountCredential }>
}
