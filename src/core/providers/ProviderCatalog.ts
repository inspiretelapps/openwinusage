import type { Account } from '../models/Account'
import { CLIProxyHub, HubLink } from '../models/CLIProxyHub'
import type { CredentialVault } from '../services/AccountCredentialVault'
import { CLIProxyHubClient, CLIProxyHubGate, HubOff, HubTunnel } from '../services/CLIProxyHubClient'
import type { HTTPClient } from '../services/HTTPClient'
import type { HubKeyVault } from '../services/HubKeyVault'
import type { Clock } from '../support/time'
import { AccountProviderRuntime } from './AccountProviderRuntime'
import { ClaudeSessions } from './claude/ClaudeSession'

export const ProviderCatalog = {
  /**
   * One runtime per account, reusing each account's runtime when it still fits. An account mirrored
   * from a hub gets a runtime whose HTTP client tunnels through that hub, rebuilt when its link changes;
   * while hubs are off, its client sends nothing.
   */
  make(options: {
    accounts: Account[]
    vault: CredentialVault
    hubKeys: HubKeyVault
    http: HTTPClient
    hubGate?: CLIProxyHubGate
    hubsEnabled?: boolean
    claudeSessions?: ClaudeSessions
    reusing?: AccountProviderRuntime[]
    now?: Clock
  }): AccountProviderRuntime[] {
    const hubGate = options.hubGate ?? new CLIProxyHubGate()
    const hubsEnabled = options.hubsEnabled ?? CLIProxyHub.isEnabled
    const claudeSessions = options.claudeSessions ?? new ClaudeSessions()
    const existingByID = new Map<string, AccountProviderRuntime>()
    for (const runtime of options.reusing ?? []) if (!existingByID.has(runtime.account.id)) existingByID.set(runtime.account.id, runtime)

    return options.accounts.map((account) => {
      const runtime = existingByID.get(account.id)
      if (!runtime || !HubLink.equal(runtime.account.hub, account.hub)) {
        let client: HTTPClient
        if (account.hub === undefined) client = options.http
        else if (hubsEnabled) client = new HubTunnel(account.hub, account.kind, options.hubKeys, new CLIProxyHubClient(options.http, hubGate))
        else client = new HubOff()
        return new AccountProviderRuntime(account, options.vault, client, options.now ?? Date.now, claudeSessions)
      }
      runtime.update(account)
      return runtime
    })
  }
}
