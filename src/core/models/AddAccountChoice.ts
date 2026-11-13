import type { LoginPrompt } from '../services/ProviderLogin'
import type { GitHubDomain } from '../providers/copilot/GitHubDomain'
import { CLIProxyHub } from './CLIProxyHub'
import { ProviderKind, type ProviderAuthMethod } from './Account'

// The Add Account flow's plain data, apart from the flow itself (`app/AddAccountFlow.ts`), which runs
// sign-ins with Node modules. The panel imports this file; it must not import anything that needs Node.

/** A row of the provider list: a provider to sign in to, or a CLIProxyAPI hub whose logins arrive as accounts of their own providers. */
export type AddAccountChoice = { type: 'provider'; kind: ProviderKind } | { type: 'cliproxyHub' }

export const AddAccountChoice = {
  get all(): AddAccountChoice[] {
    return [
      ...ProviderKind.allCases.map((kind): AddAccountChoice => ({ type: 'provider', kind })),
      ...(CLIProxyHub.isEnabled ? [{ type: 'cliproxyHub' } as AddAccountChoice] : [])
    ]
  }
}

/** What the Add Account sheet draws. Plain data: the app sends it to the panel as it is. */
export interface AddAccountFlowState {
  selection?: AddAccountChoice
  isConnectingHub: boolean
  provider?: ProviderKind
  method?: ProviderAuthMethod
  /** Where a Copilot sign-in goes, once its Domain step is done or the account being signed in again saved it. */
  gitHubDomain?: GitHubDomain
  prompt?: LoginPrompt
  isWorking: boolean
  errorMessage?: string
  isFinished: boolean
  isSigningInAgain: boolean
  /** The card id of the account being signed in again. */
  signingInAgainProviderID?: string
  /** Whether a pasted code can be sent to the sign-in that is waiting for one. */
  acceptsCode: boolean
  isCodeSubmitted: boolean
  /** Copilot's own sign-in first asks for the domain: blank for github.com, or a GHE.com address. */
  isEnteringDomain: boolean
  canChangeDomain: boolean
}
