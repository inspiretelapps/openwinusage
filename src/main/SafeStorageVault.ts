import { safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AccountCredential } from '@core/models/Account'
import { CredentialVaultError, type CredentialVault } from '@core/services/AccountCredentialVault'
import { HubKeyVault, type HubKey } from '@core/services/HubKeyVault'
import { AppInfo } from '@core/support/AppInfo'

/**
 * One encrypted file per id in a folder of the app's data. Each is encrypted by the operating system
 * for the signed-in user (DPAPI on Windows), the way the macOS app keeps one Keychain item per id.
 * Nothing is ever written unencrypted: without OS encryption every write throws.
 */
class EncryptedItems {
  constructor(private readonly folder: string) {}

  private path(id: string): string {
    if (!/^[0-9a-fA-F-]{36}$/.test(id)) throw new Error('Invalid id.')
    return join(this.folder, `${id.toLowerCase()}.bin`)
  }

  load(id: string): string | undefined {
    const path = this.path(id)
    if (!existsSync(path)) return undefined
    try {
      return safeStorage.decryptString(readFileSync(path))
    } catch (error) {
      throw new Error(`${AppInfo.name} couldn't read its saved sign-in for this account (${error instanceof Error ? error.message : String(error)}).`)
    }
  }

  exists(id: string): boolean {
    return existsSync(this.path(id))
  }

  save(text: string, id: string): void {
    if (!safeStorage.isEncryptionAvailable()) throw new Error(`${AppInfo.name} can't save sign-ins: Windows encryption isn't available for this user.`)
    mkdirSync(this.folder, { recursive: true })
    const path = this.path(id)
    const temporary = `${path}.tmp`
    writeFileSync(temporary, safeStorage.encryptString(text))
    renameSync(temporary, path)
  }

  delete(id: string): void {
    rmSync(this.path(id), { force: true })
  }
}

export class SafeStorageCredentialVault implements CredentialVault {
  private readonly items: EncryptedItems

  constructor(dataFolder: string) {
    this.items = new EncryptedItems(join(dataFolder, 'accounts'))
  }

  load(id: string): AccountCredential | undefined {
    const text = this.items.load(id)
    return text === undefined ? undefined : (JSON.parse(text) as AccountCredential)
  }

  save(credential: AccountCredential, id: string): void {
    this.items.save(JSON.stringify(credential), id)
  }

  update(credential: AccountCredential, id: string): void {
    if (!this.items.exists(id)) throw new CredentialVaultError()
    this.save(credential, id)
  }

  delete(id: string): void {
    this.items.delete(id)
  }
}

/** Management keys, in a folder of their own: a hub id can never load or delete an account's sign-in. */
export class SafeStorageHubKeyVault implements HubKeyVault {
  private readonly items: EncryptedItems

  constructor(dataFolder: string) {
    this.items = new EncryptedItems(join(dataFolder, 'cliproxy-hubs'))
  }

  load(hubID: string): HubKey | undefined {
    const text = this.items.load(hubID)
    return text === undefined ? undefined : (JSON.parse(text) as HubKey)
  }

  save(key: HubKey, hubID: string): void {
    this.items.save(JSON.stringify({ key: key.key, url: key.url }), hubID)
  }

  delete(hubID: string): void {
    this.items.delete(hubID)
  }

  key(hubID: string, url: string): string {
    return HubKeyVault.key(this, hubID, url)
  }
}
