import { Account, AccountCredential, ProviderKind, newUUID } from '../models/Account'
import { CLIProxyHub, HubLink, HubReconciliation, type HubLogin } from '../models/CLIProxyHub'
import { ProviderError } from '../providers/ProviderError'
import type { CredentialVault } from '../services/AccountCredentialVault'
import type { HubKeyVault } from '../services/HubKeyVault'
import { AppInfo } from '../support/AppInfo'
import { AppLog, LogTags, describeError } from '../support/AppLog'
import { standardDefaults, type Defaults } from '../support/Defaults'
import { Observable } from '../support/Observable'
import { asObject, isJSONObject } from '../support/ProviderParse'

function sameIgnoringCase(a: string, b: string): boolean {
  return a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0
}

/** Reads one stored account entry; throws for anything this build cannot decode. */
function decodeAccount(entry: unknown): Account {
  const object = asObject(entry)
  if (!object) throw new Error('not an object')
  const kind = ProviderKind.from(object.kind)
  if (typeof object.id !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(object.id)) throw new Error('no id')
  if (kind === undefined) throw new Error(`unknown kind ${String(object.kind)}`)
  if (typeof object.label !== 'string') throw new Error('no label')
  if (typeof object.addedAt !== 'number') throw new Error('no addedAt')
  const optionalString = (value: unknown, name: string): string | undefined => {
    if (value === undefined || value === null) return undefined
    if (typeof value !== 'string') throw new Error(`unreadable ${name}`)
    return value
  }
  let hub: HubLink | undefined
  if (object.hub !== undefined && object.hub !== null) {
    const link = asObject(object.hub)
    if (
      !link ||
      typeof link.hubID !== 'string' ||
      typeof link.hubURL !== 'string' ||
      typeof link.loginID !== 'string' ||
      typeof link.authIndex !== 'string'
    ) {
      throw new Error('unreadable hub link')
    }
    hub = { hubID: link.hubID.toLowerCase(), hubURL: link.hubURL, loginID: link.loginID, authIndex: link.authIndex }
    const workspace = optionalString(link.chatGPTAccountID, 'chatGPTAccountID')
    if (workspace !== undefined) hub.chatGPTAccountID = workspace
  }
  return Account.make({
    id: object.id,
    kind,
    label: object.label,
    organization: optionalString(object.organization, 'organization'),
    domain: optionalString(object.domain, 'domain'),
    hub,
    addedAt: object.addedAt
  })
}

function decodeHubs(stored: unknown): CLIProxyHub[] {
  if (!Array.isArray(stored)) throw new Error('not a list')
  return stored.map((entry) => {
    if (!isJSONObject(entry) || typeof entry.id !== 'string' || typeof entry.url !== 'string' || typeof entry.addedAt !== 'number') {
      throw new Error('unreadable hub')
    }
    return { id: entry.id.toLowerCase(), url: entry.url, addedAt: entry.addedAt }
  })
}

/** Accounts, CLIProxyAPI hubs, and the vaults their sign-ins live in. The source of truth for both. */
export class AccountStore extends Observable {
  static readonly storageKey = 'accounts.v1'
  static readonly hubsStorageKey = 'cliproxyHubs.v1'

  private accountList: Account[]
  private hubList: CLIProxyHub[]
  lastError: string | undefined
  didChange: (() => void) | undefined
  /**
   * The stored entries this build cannot decode, as JSON values. Saving writes them back after the
   * accounts, so a build that reads them still finds them.
   */
  private unreadableEntries: unknown[]
  private readonly defaults: Defaults
  readonly credentialVault: CredentialVault
  readonly hubKeys: HubKeyVault
  private readonly makeID: () => string
  /** The hub accounts whose logins the last listing of their hub lacked. */
  private unlistedHubAccounts = new Set<string>()

  constructor(options: { defaults?: Defaults; vault: CredentialVault; hubKeys: HubKeyVault; makeID?: () => string }) {
    super()
    this.defaults = options.defaults ?? standardDefaults()
    this.credentialVault = options.vault
    this.hubKeys = options.hubKeys
    this.makeID = options.makeID ?? newUUID
    const stored = AccountStore.load(this.defaults)
    this.accountList = stored.accounts.map((account) => ({ ...account, label: AccountStore.nameFor(account.label, account.kind) }))
    this.unreadableEntries = stored.unreadableEntries
    this.hubList = AccountStore.loadHubs(this.defaults)
    const renamed = this.accountList.filter((account, index) => account.label !== stored.accounts[index].label)
    if (renamed.length > 0) {
      AppLog.info(LogTags.auth('accounts'), `named ${renamed.map((account) => Account.cardID(account)).join(', ')}, which had no name the dashboard shows`)
      this.persist()
    }
  }

  get accounts(): readonly Account[] {
    return this.accountList
  }

  get hubs(): readonly CLIProxyHub[] {
    return this.hubList
  }

  /**
   * The dashboard leaves out a name that only repeats the provider's, so a blank name or the provider's
   * own becomes the provider's default account name.
   */
  static nameFor(label: string, kind: ProviderKind): string {
    const name = label.trim()
    const provider = ProviderKind.displayName(kind)
    return name.length === 0 || sameIgnoringCase(name, provider) ? `${provider} Account` : name
  }

  /** The stored accounts, oldest first, and the entries this build cannot read. */
  static load(defaults: Defaults): { accounts: Account[]; unreadableEntries: unknown[] } {
    const stored = defaults.get(AccountStore.storageKey)
    if (stored === undefined) return { accounts: [], unreadableEntries: [] }
    if (!Array.isArray(stored)) {
      AppLog.error(LogTags.auth('accounts'), 'cannot read the stored account list, which is not a JSON array')
      return { accounts: [], unreadableEntries: [] }
    }
    const accounts: Account[] = []
    const unreadableEntries: unknown[] = []
    stored.forEach((entry, index) => {
      try {
        accounts.push(decodeAccount(entry))
      } catch (error) {
        AppLog.error(LogTags.auth('accounts'), `cannot read stored account entry ${index}, keeping it unchanged: ${describeError(error)}`)
        unreadableEntries.push(entry)
      }
    })
    // A stable sort keeps entries added in the same instant in their stored order.
    return {
      accounts: accounts
        .map((account, index) => ({ account, index }))
        .sort((a, b) => a.account.addedAt - b.account.addedAt || a.index - b.index)
        .map((entry) => entry.account),
      unreadableEntries
    }
  }

  static loadHubs(defaults: Defaults): CLIProxyHub[] {
    const stored = defaults.get(AccountStore.hubsStorageKey)
    if (stored === undefined) return []
    try {
      return decodeHubs(stored)
    } catch (error) {
      AppLog.error(LogTags.auth('cliproxy'), `cannot read the stored hub list: ${describeError(error)}`)
      return []
    }
  }

  add(options: { kind: ProviderKind; label: string; organization?: string; domain?: string; credential: AccountCredential }): Account {
    const account = this.newAccount(options.kind, options.label, options.organization, options.domain)
    try {
      this.credentialVault.save(options.credential, account.id)
      this.accountList = [...this.accountList, account]
      this.persist()
      this.changed()
    } catch (error) {
      this.lastError = describeError(error)
      AppLog.error(LogTags.auth('accounts'), `could not save account: ${describeError(error)}`)
      this.notify()
    }
    return account
  }

  rename(id: string, label: string): void {
    const index = this.accountList.findIndex((account) => account.id === id)
    if (index < 0) return
    const next = [...this.accountList]
    next[index] = { ...next[index], label: AccountStore.nameFor(label, next[index].kind) }
    this.accountList = next
    this.persist()
    this.changed()
  }

  remove(id: string): void {
    const index = this.accountList.findIndex((account) => account.id === id)
    if (index < 0) return
    try {
      this.credentialVault.delete(id)
      this.accountList = this.accountList.filter((account) => account.id !== id)
      this.persist()
      this.changed()
    } catch (error) {
      this.lastError = describeError(error)
      AppLog.error(LogTags.auth('accounts'), `could not remove account credential: ${describeError(error)}`)
      this.notify()
    }
  }

  /**
   * It saves rather than updates: a pasted key is the whole credential, so it also restores an account
   * whose stored sign-in has gone missing.
   */
  replaceCredential(credential: AccountCredential, id: string): void {
    const account = this.accountList.find((candidate) => candidate.id === id)
    if (!account) return
    this.checkForDuplicate(credential, account.kind, account.organization, id)
    this.credentialVault.save(credential, id)
  }

  credential(id: string): AccountCredential | undefined {
    return this.credentialVault.load(id)
  }

  /**
   * Matches a direct sign-in by organization or credential identity. A missing stored sign-in
   * cannot match, but an unreadable one cannot establish that the sign-in is distinct.
   */
  checkForDuplicate(credential: AccountCredential, kind: ProviderKind, organization: string | undefined, excluding?: string): void {
    const identity = AccountCredential.identity(credential)
    for (const account of this.accountList) {
      if (account.kind !== kind || account.hub !== undefined || account.id === excluding) continue
      if (organization !== undefined) {
        if (account.organization === undefined || !sameIgnoringCase(account.organization, organization)) continue
      } else {
        if (account.organization !== undefined) continue
        if (identity === undefined) return
        let stored: AccountCredential | undefined
        try {
          stored = this.credentialVault.load(account.id)
        } catch (error) {
          AppLog.error('auth', `${Account.cardID(account)} could not check its stored sign-in for a duplicate: ${describeError(error)}`)
          throw ProviderError.unavailable(`${AppInfo.name} couldn't check the saved sign-in for ${account.label}. Try again.`)
        }
        if (!stored || AccountCredential.identity(stored) !== identity) continue
      }
      throw ProviderError.unavailable(`This account is already added as ${account.label}.`)
    }
  }

  account(cardID: string): Account | undefined {
    return this.accountList.find((account) => Account.cardID(account) === cardID)
  }

  accountsOnHub(hubID: string): Account[] {
    return this.accountList.filter((account) => account.hub?.hubID === hubID)
  }

  /** Saves a newly connected hub and its management key, bound to the hub's address. Its logins arrive with `mirror`. */
  addHub(hub: CLIProxyHub, key: string): void {
    this.hubKeys.save({ key, url: hub.url }, hub.id)
    this.hubList = [...this.hubList, hub]
    this.persistHubs()
    this.notify()
  }

  replaceHubKey(key: string, hubID: string): void {
    const hub = this.hubList.find((candidate) => candidate.id === hubID)
    if (!hub) return
    this.hubKeys.save({ key, url: hub.url }, hubID)
  }

  /** Removes a hub together with every account mirrored from it and its management key. */
  removeHub(hubID: string): void {
    const mirrored = new Set(this.accountsOnHub(hubID).map((account) => account.id))
    try {
      for (const id of mirrored) this.credentialVault.delete(id)
      this.hubKeys.delete(hubID)
    } catch (error) {
      this.lastError = describeError(error)
      AppLog.error(LogTags.auth('cliproxy'), `could not remove a hub's credentials: ${describeError(error)}`)
      this.notify()
      return
    }
    this.accountList = this.accountList.filter((account) => !mirrored.has(account.id))
    this.hubList = this.hubList.filter((hub) => hub.id !== hubID)
    this.persistHubs()
    this.persist()
    this.changed()
  }

  /**
   * Makes the hub's mirrored accounts match its login list: a new login is added at the bottom of its
   * provider's accounts, a login disabled on the hub is removed, a login gone from the hub is removed
   * once two listings in a row lack it, and a renamed one, or one switched to another ChatGPT workspace,
   * is relinked. The same listing applied twice changes nothing the second time. Throws when a vault
   * write fails, after applying the rest.
   */
  mirror(logins: HubLogin[], hubID: string): void {
    const hub = this.hubList.find((candidate) => candidate.id === hubID)
    if (!hub) return
    const plan = HubReconciliation.make(hub, logins, this.accountList, this.unlistedHubAccounts)
    for (const account of this.accountsOnHub(hubID)) this.unlistedHubAccounts.delete(account.id)
    for (const id of plan.missing) this.unlistedHubAccounts.add(id)
    if (HubReconciliation.isEmpty(plan)) return
    const failures: unknown[] = []
    const removed = new Set<string>()
    for (const id of plan.removed) {
      try {
        this.credentialVault.delete(id)
        removed.add(id)
      } catch (error) {
        failures.push(error)
      }
    }
    let accounts = this.accountList.filter((account) => !removed.has(account.id))
    for (const id of plan.removed) if (!removed.has(id)) this.unlistedHubAccounts.add(id)
    accounts = accounts.map((account) => {
      const link = plan.relinked.get(account.id)
      if (!link) return account
      try {
        if (link.chatGPTAccountID !== account.hub?.chatGPTAccountID) this.credentialVault.save(HubLink.credential(link), account.id)
        return { ...account, hub: link }
      } catch (error) {
        failures.push(error)
        return account
      }
    })
    this.accountList = accounts
    for (const { kind, label, link } of plan.added) {
      const account = this.newAccount(kind, label, undefined, undefined, link)
      try {
        this.credentialVault.save(HubLink.credential(link), account.id)
        this.accountList = [...this.accountList, account]
      } catch (error) {
        failures.push(error)
      }
    }
    AppLog.info(LogTags.auth('cliproxy'), `${CLIProxyHub.host(hub)}: ${plan.added.length} added, ${removed.size} removed, ${plan.relinked.size} relinked`)
    this.persist()
    this.changed()
    if (failures.length > 0) {
      AppLog.error(
        LogTags.auth('cliproxy'),
        `could not save ${failures.length} of ${CLIProxyHub.host(hub)}'s logins: ${describeError(failures[0])}`
      )
      throw ProviderError.unavailable(`${AppInfo.name} couldn’t save this hub’s logins. It tries again when Accounts opens.`)
    }
  }

  /**
   * A card id keeps only the first 8 hex digits of the account's id, and two cards with one id break
   * the dashboard, so an id whose card id is taken is drawn again.
   */
  private newAccount(kind: ProviderKind, label: string, organization?: string, domain?: string, hub?: HubLink): Account {
    for (;;) {
      const account = Account.make({ id: this.makeID(), kind, label: AccountStore.nameFor(label, kind), organization, domain, hub })
      if (this.account(Account.cardID(account)) === undefined) return account
    }
  }

  private changed(): void {
    this.didChange?.()
    this.notify()
  }

  private persistHubs(): void {
    this.defaults.set(
      AccountStore.hubsStorageKey,
      this.hubList.map((hub) => ({ ...hub }))
    )
  }

  private persist(): void {
    this.defaults.set(AccountStore.storageKey, [...this.accountList.map((account) => structuredClone(account)), ...this.unreadableEntries])
  }
}
