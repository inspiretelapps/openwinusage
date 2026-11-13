import { AppContainer } from '../app/AppContainer'
import { AccountCredential, type Account } from '../models/Account'
import type { ProviderSnapshot } from '../models/ProviderSnapshot'
import { AccountStore } from '../stores/AccountStore'
import { AppLog } from '../support/AppLog'
import type { Defaults } from '../support/Defaults'
import { Observable } from '../support/Observable'
import type { Instant } from '../support/time'
import { DemoFactory } from './DemoFactory'
import { DemoProviderRuntime } from './DemoProviderRuntime'
import { DemoRandom } from './DemoRandom'
import { DemoCredentialVault, DemoHTTPClient, DemoHubKeyVault } from './DemoServices'

/** One run of the sample-data mode: its seed and the sample readings its accounts show. */
export class DemoSession extends Observable {
  static readonly seeds = { lower: 1, upper: 999_999 }

  seed = 0
  private snapshots = new Map<string, ProviderSnapshot>()
  private random = new DemoRandom(0)

  private constructor(private readonly accounts: AccountStore) {
    super()
  }

  private static randomSeed(): number {
    return DemoSession.seeds.lower + Math.floor(Math.random() * (DemoSession.seeds.upper - DemoSession.seeds.lower + 1))
  }

  /**
   * Builds a container on sample data. `defaults` must be a store of the demo's own (in memory), so it
   * can never touch the real app's accounts or settings.
   */
  static makeContainer(
    defaults: Defaults,
    options: { seed?: number; now?: Instant; postNotification?: ConstructorParameters<typeof AppContainer>[0]['postNotification'] } = {}
  ): { container: AppContainer; session: DemoSession } {
    const store = new AccountStore({ defaults, vault: new DemoCredentialVault(), hubKeys: new DemoHubKeyVault() })
    const session = new DemoSession(store)
    const container = new AppContainer({
      accounts: store,
      defaults,
      http: new DemoHTTPClient(),
      postNotification: options.postNotification,
      runtimeFactory: (accounts, existing) => DemoProviderRuntime.make(accounts, existing, (account) => session.snapshot(account))
    })
    session.shuffle(options.seed ?? DemoSession.randomSeed(), options.now ?? Date.now())
    AppLog.info('lifecycle', `demo seed ${session.seed}`)
    return { container, session }
  }

  reshuffle(): void {
    this.shuffle(DemoSession.randomSeed(), Date.now())
    AppLog.info('lifecycle', `demo seed ${this.seed}`)
    this.notify()
  }

  snapshot(account: Account): ProviderSnapshot {
    const existing = this.snapshots.get(account.id)
    if (existing) return existing
    const added = DemoFactory.snapshots([account], Date.now(), this.random).get(account.id) as ProviderSnapshot
    this.snapshots.set(account.id, added)
    return added
  }

  /** Replaces every account in place, so the dashboard swaps runtimes as it does for any account change. */
  private shuffle(seed: number, now: Instant): void {
    this.seed = seed
    this.random = new DemoRandom(seed)
    for (const account of [...this.accounts.accounts]) this.accounts.remove(account.id)
    for (const entry of DemoFactory.accounts(this.random)) {
      this.accounts.add({ kind: entry.kind, label: entry.label, organization: entry.organization, credential: AccountCredential.apiKey('sample') })
    }
    // Each added account's first refresh waits a turn before it reads, so these readings are in place by then.
    this.snapshots = DemoFactory.snapshots(this.accounts.accounts, now, this.random)
  }
}
