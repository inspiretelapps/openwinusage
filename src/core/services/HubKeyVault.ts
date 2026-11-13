import { CLIProxyHub } from '../models/CLIProxyHub'
import { ProviderError } from '../providers/ProviderError'
import { AppLog, LogTags } from '../support/AppLog'

/**
 * A hub's management key and the address the user connected the hub at. The key is sent only to that
 * address, so a hub address rewritten in preferences can't redirect it.
 */
export interface HubKey {
  readonly key: string
  readonly url: string
}

/**
 * Management keys, in a store of their own: a hub id can never load or delete an account's sign-in.
 * The desktop app's vault encrypts each key with the user's Windows login (DPAPI); it is the port of
 * the macOS Keychain service. Every method is synchronous and throws on failure, as the Keychain calls do.
 */
export interface HubKeyVault {
  load(hubID: string): HubKey | undefined
  save(key: HubKey, hubID: string): void
  delete(hubID: string): void
  /** The hub's management key, only for the address it was saved for. Implement it as `HubKeyVault.key(this, hubID, url)`. */
  key(hubID: string, url: string): string
}

export const HubKeyVault = {
  /** The protocol extension's `key(for:at:)`, which every vault's `key` returns. */
  key(vault: Pick<HubKeyVault, 'load'>, hubID: string, url: string): string {
    const host = CLIProxyHub.hostOf(url)
    const stored = vault.load(hubID)
    if (!stored) {
      AppLog.error(LogTags.auth('cliproxy'), `${host} has no stored management key`)
      throw ProviderError.unavailable(`The management key for the CLIProxyAPI hub at ${host} is missing. Replace it in Accounts.`)
    }
    if (stored.url !== url) {
      AppLog.error(LogTags.auth('cliproxy'), `${host} is not the address its management key was saved for; not sending it`)
      throw ProviderError.unavailable(
        `The CLIProxyAPI hub at ${host} isn’t the address its management key was saved for. Remove the hub and connect it again.`
      )
    }
    return stored.key
  }
}

/** Keeps management keys in memory only: for tests and the sample-data mode. */
export class MemoryHubKeyVault implements HubKeyVault {
  readonly items = new Map<string, HubKey>()

  load(hubID: string): HubKey | undefined {
    const stored = this.items.get(hubID.toLowerCase())
    return stored === undefined ? undefined : { ...stored }
  }
  save(key: HubKey, hubID: string): void {
    this.items.set(hubID.toLowerCase(), { key: key.key, url: key.url })
  }
  delete(hubID: string): void {
    this.items.delete(hubID.toLowerCase())
  }
  key(hubID: string, url: string): string {
    return HubKeyVault.key(this, hubID, url)
  }
}
