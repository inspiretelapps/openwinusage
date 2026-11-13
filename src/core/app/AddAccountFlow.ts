import { Account, ProviderKind, type AccountCredential, type ProviderAuthMethod } from '../models/Account'
import { CLIProxyHub } from '../models/CLIProxyHub'
import { GitHubDomain } from '../providers/copilot/GitHubDomain'
import { ProviderLoginCatalog } from '../services/DeviceProviderLogins'
import type { LoginPrompt, ProviderLogin } from '../services/ProviderLogin'
import type { AccountStore } from '../stores/AccountStore'
import { AppLog, LogTags, describeError } from '../support/AppLog'
import { AsyncStream } from '../support/AsyncStream'
import { Observable } from '../support/Observable'

export { AddAccountChoice, type AddAccountFlowState } from '../models/AddAccountChoice'
import { AddAccountChoice, type AddAccountFlowState } from '../models/AddAccountChoice'

export type LoginFactory = (kind: ProviderKind, method: ProviderAuthMethod, organization: string, domain: GitHubDomain) => ProviderLogin

/**
 * The Add Account sheet's state machine: pick a provider, run its sign-in, and save the account. What
 * the user types (key, name, code, organization, domain, hub address) stays in the sheet and arrives
 * with the action that uses it.
 */
export class AddAccountFlow extends Observable {
  private selection: AddAccountChoice | undefined
  private isConnectingHub = false
  private provider: ProviderKind | undefined
  private method: ProviderAuthMethod | undefined
  private gitHubDomain: GitHubDomain | undefined
  private prompt: LoginPrompt | undefined
  private isWorking = false
  private errorMessage: string | undefined
  private isFinished = false

  private readonly store: AccountStore
  private readonly openURL: (url: string) => void
  private readonly login: LoginFactory
  private readonly connectHub: (url: string, key: string, signal: AbortSignal) => Promise<void>
  private readonly replaceCredential: (credential: AccountCredential, providerID: string, signal: AbortSignal) => Promise<void>
  private readonly accountSignedInAgain: Account | undefined
  private task: AbortController | undefined
  private codeInput: AsyncStream<string> | undefined

  constructor(options: {
    store: AccountStore
    openURL: (url: string) => void
    login?: LoginFactory
    connectHub?: (url: string, key: string, signal: AbortSignal) => Promise<void>
    replaceCredential?: (credential: AccountCredential, providerID: string, signal: AbortSignal) => Promise<void>
    signingInAgainTo?: Account
  }) {
    super()
    this.store = options.store
    this.openURL = options.openURL
    this.login = options.login ?? ((kind, method, organization, domain) => ProviderLoginCatalog.login(kind, method, organization, domain))
    this.connectHub = options.connectHub ?? (async () => undefined)
    this.replaceCredential = options.replaceCredential ?? (async () => undefined)
    this.accountSignedInAgain = options.signingInAgainTo
    const account = options.signingInAgainTo
    if (account) {
      this.selection = { type: 'provider', kind: account.kind }
      this.provider = account.kind
      this.method = Account.authMethod(account)
      this.gitHubDomain = GitHubDomain.fromSaved(account.domain)
    }
  }

  get isSigningInAgain(): boolean {
    return this.accountSignedInAgain !== undefined
  }

  get isEnteringDomain(): boolean {
    return this.provider === 'copilot' && this.method?.type === 'oauth' && this.gitHubDomain === undefined
  }

  get canChangeDomain(): boolean {
    return this.provider === 'copilot' && this.method?.type === 'oauth' && !this.isSigningInAgain
  }

  get finished(): boolean {
    return this.isFinished
  }

  get state(): AddAccountFlowState {
    const state: AddAccountFlowState = {
      isConnectingHub: this.isConnectingHub,
      isWorking: this.isWorking,
      isFinished: this.isFinished,
      isSigningInAgain: this.isSigningInAgain,
      acceptsCode: this.codeInput !== undefined,
      isCodeSubmitted: this.isWorking && this.prompt !== undefined && this.codeInput === undefined,
      isEnteringDomain: this.isEnteringDomain,
      canChangeDomain: this.canChangeDomain
    }
    if (this.selection) state.selection = this.selection
    if (this.provider) state.provider = this.provider
    if (this.method) state.method = this.method
    if (this.gitHubDomain) state.gitHubDomain = this.gitHubDomain
    if (this.prompt) state.prompt = this.prompt
    if (this.errorMessage !== undefined) state.errorMessage = this.errorMessage
    if (this.accountSignedInAgain) state.signingInAgainProviderID = Account.cardID(this.accountSignedInAgain)
    return state
  }

  /** Editing the field an error is about clears the error. */
  clearError(): void {
    if (this.errorMessage === undefined) return
    this.errorMessage = undefined
    this.notify()
  }

  choose(kind: ProviderKind): void {
    this.selection = { type: 'provider', kind }
    this.provider = kind
    const methods = ProviderKind.authMethods(kind)
    if (methods.length === 1) this.chooseMethod(methods[0])
    else this.notify()
  }

  chooseMethod(method: ProviderAuthMethod): void {
    this.method = method
    if (method.type === 'oauth' && !this.isEnteringDomain) this.signIn()
    else this.notify()
  }

  continueToSignIn(domain: string): void {
    const parsed = GitHubDomain.parsing(domain)
    if (!parsed) {
      AppLog.warn(LogTags.auth('copilot'), 'the entered domain is not a GHE.com address')
      this.errorMessage = GitHubDomain.invalidMessage
      this.notify()
      return
    }
    this.errorMessage = undefined
    this.gitHubDomain = parsed
    this.signIn()
  }

  /** Back to the Domain step, keeping what was typed. */
  changeDomain(): void {
    this.gitHubDomain = undefined
    this.errorMessage = undefined
    this.notify()
  }

  chooseHub(): void {
    this.selection = { type: 'cliproxyHub' }
    this.isConnectingHub = true
    this.notify()
  }

  /** Connects a CLIProxyAPI hub; its logins arrive as accounts, so the sheet closes once it answers. */
  connect(hubURL: string, apiKey: string): void {
    if (!this.isConnectingHub || hubURL.trim().length === 0 || apiKey.trim().length === 0 || this.isWorking) return
    this.task?.abort()
    const task = new AbortController()
    this.task = task
    this.errorMessage = undefined
    this.isWorking = true
    this.notify()
    void (async (): Promise<void> => {
      try {
        await this.connectHub(hubURL, apiKey, task.signal)
        if (task.signal.aborted) return
        this.isWorking = false
        this.isFinished = true
        this.notify()
      } catch (error) {
        if (task.signal.aborted) return
        this.fail(describeError(error))
      }
    })()
  }

  /** Starts once the sheet shows: creating a flow must not open a browser. */
  startSigningInAgain(): void {
    if (!this.isSigningInAgain || this.prompt !== undefined || this.isWorking) return
    this.signIn()
  }

  signIn(): void {
    if (!this.provider || !this.method) return
    const input = new AsyncStream<string>()
    this.codeInput = input
    this.run(this.provider, this.method, input, '', '')
  }

  openBrowser(): void {
    const prompt = this.prompt
    if (!prompt) return
    this.openURL(prompt.type === 'deviceCode' ? prompt.verificationURL : prompt.url)
  }

  submitCode(pastedCode: string): void {
    if (pastedCode.trim().length === 0 || !this.codeInput) return
    this.codeInput.yield(pastedCode)
    this.codeInput.finish()
    this.codeInput = undefined
    this.notify()
  }

  addKey(apiKey: string, accountName: string, organization: string): void {
    if (!this.provider || !this.method) return
    if (apiKey.trim().length === 0 || this.isWorking) return
    if (this.method.type === 'organizationToken' && organization.trim().length === 0) return
    const input = new AsyncStream<string>()
    input.yield(apiKey)
    input.finish()
    this.run(this.provider, this.method, input, accountName, organization)
  }

  back(): void {
    this.cancel()
    this.provider = undefined
    this.isConnectingHub = false
    this.method = undefined
    this.gitHubDomain = undefined
    this.prompt = undefined
    this.errorMessage = undefined
    this.isWorking = false
    this.notify()
  }

  cancel(): void {
    this.task?.abort()
    this.task = undefined
    this.codeInput?.finish()
    this.codeInput = undefined
  }

  private run(kind: ProviderKind, method: ProviderAuthMethod, input: AsyncStream<string>, accountName: string, typedOrganization: string): void {
    this.task?.abort()
    const task = new AbortController()
    this.task = task
    this.prompt = undefined
    this.errorMessage = undefined
    this.isWorking = true
    const organization = method.type === 'organizationToken' ? typedOrganization.trim() : undefined
    const gitHubDomain = this.gitHubDomain
    const login = this.login(kind, method, organization ?? '', gitHubDomain ?? GitHubDomain.github)
    this.notify()
    void (async (): Promise<void> => {
      try {
        const result = await login.login((prompt) => this.show(prompt, task.signal), input, task.signal)
        if (task.signal.aborted) return
        if (this.accountSignedInAgain) {
          await this.replaceCredential(result.credential, Account.cardID(this.accountSignedInAgain), task.signal)
          if (task.signal.aborted) return
          this.finish()
        } else {
          this.save(result, kind, organization, gitHubDomain ? GitHubDomain.saved(gitHubDomain) : undefined, accountName)
        }
      } catch (error) {
        if (task.signal.aborted) return
        this.fail(describeError(error))
      }
    })()
  }

  private show(prompt: LoginPrompt, signal: AbortSignal): void {
    if (signal.aborted) return
    this.prompt = prompt
    if (prompt.type !== 'deviceCode') this.openURL(prompt.url)
    this.notify()
  }

  private save(
    result: { label: string; credential: AccountCredential },
    kind: ProviderKind,
    organization: string | undefined,
    domain: string | undefined,
    accountName: string
  ): void {
    this.store.checkForDuplicate(result.credential, kind, organization)
    const name = accountName.trim()
    const account = this.store.add({ kind, label: name.length === 0 ? result.label : name, organization, domain, credential: result.credential })
    if (!this.store.accounts.some((candidate) => candidate.id === account.id)) {
      this.fail(this.store.lastError ?? 'The account could not be saved.')
      return
    }
    this.finish()
  }

  private finish(): void {
    this.codeInput?.finish()
    this.codeInput = undefined
    this.isWorking = false
    this.isFinished = true
    this.notify()
  }

  private fail(message: string): void {
    this.codeInput?.finish()
    this.codeInput = undefined
    this.prompt = undefined
    this.isWorking = false
    this.errorMessage = message
    this.notify()
  }
}
