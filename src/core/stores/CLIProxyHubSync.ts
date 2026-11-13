import { CLIProxyHub, HubLogin } from '../models/CLIProxyHub'
import { newUUID } from '../models/Account'
import { ProviderError } from '../providers/ProviderError'
import type { CLIProxyHubClient } from '../services/CLIProxyHubClient'
import { describeError } from '../support/AppLog'
import { Observable } from '../support/Observable'
import { secondsBetween, type Clock, type Instant, type Seconds } from '../support/time'
import type { AccountStore } from './AccountStore'
import { RefreshSetting } from './RefreshSetting'

export type HubSyncStatus = { type: 'checking' } | { type: 'synced'; unsupported: number } | { type: 'failed'; message: string }

/**
 * Keeps each connected CLIProxyAPI hub's mirrored accounts in step with its login list, and holds what
 * the hub's row in Accounts shows. A hub is re-read at launch, when Accounts opens, on Refresh, and about
 * once an hour.
 */
export class CLIProxyHubSync extends Observable {
  private statusByHub = new Map<string, HubSyncStatus>()
  private syncedAt = new Map<string, Instant>()
  private inFlight = new Map<string, Promise<void>>()

  constructor(
    private readonly accounts: AccountStore,
    private readonly client: CLIProxyHubClient,
    private readonly isEnabled: boolean = CLIProxyHub.isEnabled,
    private readonly now: Clock = Date.now
  ) {
    super()
  }

  get statuses(): ReadonlyMap<string, HubSyncStatus> {
    return this.statusByHub
  }

  status(hubID: string): HubSyncStatus {
    if (!this.isEnabled) return { type: 'failed', message: CLIProxyHub.offMessage }
    return this.statusByHub.get(hubID) ?? { type: 'checking' }
  }

  /** Connects a hub once its login list answers to the key, so a wrong URL or key saves nothing. */
  async connect(input: string, rawKey: string, signal?: AbortSignal): Promise<void> {
    const url = CLIProxyHub.baseURL(input)
    if (url === undefined) {
      throw ProviderError.unavailable('Enter the hub’s address, like https://hub.example.com or http://192.168.1.20:8317.')
    }
    const key = rawKey.trim()
    if (key.length === 0) throw ProviderError.unavailable('Enter the hub’s management key.')
    if (this.accounts.hubs.some((hub) => hub.url === url)) {
      throw ProviderError.unavailable(`The hub at ${CLIProxyHub.hostOf(url)} is already connected.`)
    }
    const hub = CLIProxyHub.make(url)
    let logins: HubLogin[]
    try {
      logins = await this.client.logins(hub.id, url, key)
    } catch (error) {
      if (!ProviderError.is(error, 'unreachable')) throw error
      const plain = await this.client.plainHTTPAddress(url)
      if (plain === undefined) throw error
      throw ProviderError.unavailable(`This hub doesn’t use https. Try ${plain}.`)
    }
    if (signal?.aborted) return
    if (this.accounts.hubs.some((existing) => existing.url === url)) return
    this.accounts.addHub(hub, key)
    this.record(logins, hub.id)
  }

  /** Saves a new management key only once the hub accepts it, then lets the hub be called again. */
  async replaceKey(rawKey: string, hubID: string): Promise<void> {
    if (!this.isEnabled) throw ProviderError.unavailable(CLIProxyHub.offMessage)
    const hub = this.accounts.hubs.find((candidate) => candidate.id === hubID)
    if (!hub) return
    const key = rawKey.trim()
    const logins = await this.client.logins(newUUID(), hub.url, key)
    this.accounts.replaceHubKey(key, hubID)
    this.client.gate.reopen(hubID)
    this.record(logins, hubID)
  }

  remove(hubID: string): void {
    this.accounts.removeHub(hubID)
    if (this.accounts.hubs.some((hub) => hub.id === hubID)) return
    this.statusByHub.delete(hubID)
    this.syncedAt.delete(hubID)
    this.client.gate.reopen(hubID)
    this.notify()
  }

  /** Re-reads every hub not read within `maxAge`. */
  async syncDue(maxAge: Seconds = RefreshSetting.secondaryReadInterval): Promise<void> {
    if (!this.isEnabled) return
    const due = this.accounts.hubs.filter((hub) => {
      const at = this.syncedAt.get(hub.id)
      return at === undefined || secondsBetween(this.now(), at) >= maxAge
    })
    await Promise.all(due.map((hub) => this.sync(hub.id)))
  }

  private async sync(hubID: string): Promise<void> {
    const running = this.inFlight.get(hubID)
    if (running) return running
    const task = this.read(hubID)
    this.inFlight.set(hubID, task)
    try {
      await task
    } finally {
      this.inFlight.delete(hubID)
    }
  }

  private async read(hubID: string): Promise<void> {
    const hub = this.accounts.hubs.find((candidate) => candidate.id === hubID)
    if (!hub) return
    this.syncedAt.set(hubID, this.now())
    try {
      const key = this.accounts.hubKeys.key(hubID, hub.url)
      this.record(await this.client.logins(hubID, hub.url, key), hubID)
    } catch (error) {
      if (!this.accounts.hubs.some((candidate) => candidate.id === hubID)) return
      this.statusByHub.set(hubID, { type: 'failed', message: describeError(error) })
      this.notify()
    }
  }

  /** A failed vault write leaves the hub unread, so the next sync tries again. */
  private record(logins: HubLogin[], hubID: string): void {
    if (!this.accounts.hubs.some((hub) => hub.id === hubID)) return
    try {
      this.accounts.mirror(logins, hubID)
    } catch (error) {
      this.syncedAt.delete(hubID)
      this.statusByHub.set(hubID, { type: 'failed', message: describeError(error) })
      this.notify()
      return
    }
    this.syncedAt.set(hubID, this.now())
    this.statusByHub.set(hubID, { type: 'synced', unsupported: logins.filter(HubLogin.isUnsupported).length })
    this.notify()
  }
}
