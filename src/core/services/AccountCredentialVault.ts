import type { AccountCredential } from '../models/Account'
import { AppInfo } from '../support/AppInfo'

/**
 * Where each account's sign-in is kept, one credential per account id. On Windows the app's vault
 * encrypts each one with the user's Windows login (DPAPI) in the app's own data folder; it is the
 * port of the macOS Keychain service. Every method is synchronous and throws on failure, as the
 * Keychain calls do.
 */
export interface CredentialVault {
  load(id: string): AccountCredential | undefined
  /** Adds or replaces. */
  save(credential: AccountCredential, id: string): void
  /** Replaces an existing credential; throws `CredentialVaultError` when the account has none. */
  update(credential: AccountCredential, id: string): void
  delete(id: string): void
}

export class CredentialVaultError extends Error {
  constructor() {
    super(`This account's sign-in is missing from ${AppInfo.name}'s secure storage. Sign in again from the account's page.`)
    this.name = 'CredentialVaultError'
  }
}

/** Holds one sign-in in memory, so a new one proves itself without seeing the sign-in it would replace. */
export class ProvisionalCredentialVault implements CredentialVault {
  private stored: AccountCredential | undefined

  constructor(credential: AccountCredential) {
    this.stored = credential
  }

  load(): AccountCredential | undefined {
    return this.stored
  }
  save(credential: AccountCredential): void {
    this.stored = credential
  }
  update(credential: AccountCredential): void {
    this.stored = credential
  }
  delete(): void {
    this.stored = undefined
  }
}

/** Keeps credentials in memory only: for tests and the sample-data mode. */
export class MemoryCredentialVault implements CredentialVault {
  readonly items = new Map<string, AccountCredential>()

  load(id: string): AccountCredential | undefined {
    const stored = this.items.get(id.toLowerCase())
    return stored === undefined ? undefined : (JSON.parse(JSON.stringify(stored)) as AccountCredential)
  }
  save(credential: AccountCredential, id: string): void {
    this.items.set(id.toLowerCase(), JSON.parse(JSON.stringify(credential)) as AccountCredential)
  }
  update(credential: AccountCredential, id: string): void {
    if (!this.items.has(id.toLowerCase())) throw new CredentialVaultError()
    this.save(credential, id)
  }
  delete(id: string): void {
    this.items.delete(id.toLowerCase())
  }
}
