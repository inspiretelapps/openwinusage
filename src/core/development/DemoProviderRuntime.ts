import type { Account } from '../models/Account'
import { Provider } from '../models/Provider'
import type { ProviderSnapshot, RefreshResult } from '../models/ProviderSnapshot'
import type { WidgetDescriptor } from '../models/WidgetDescriptor'
import { widgetDescriptors } from '../providers/AccountProviderRuntime+Descriptors'
import type { ProviderRuntime } from '../providers/ProviderRuntime'

/** The real dashboard reads the demo's sample readings through its existing runtime contract. */
export class DemoProviderRuntime implements ProviderRuntime {
  constructor(
    public account: Account,
    private readonly read: (account: Account) => ProviderSnapshot
  ) {}

  get provider(): Provider {
    return Provider.forAccount(this.account)
  }

  get widgetDescriptors(): WidgetDescriptor[] {
    return widgetDescriptors(this.account)
  }

  async refresh(): Promise<RefreshResult> {
    // A turn later, so a shuffle that adds accounts has drawn their readings before the first read.
    await Promise.resolve()
    return { ok: true, snapshot: { ...this.read(this.account), refreshedAt: Date.now() } }
  }

  forgetHourlyReads(): void {}
  restore(): void {}
  async refreshHourlyReads(): Promise<ProviderSnapshot | undefined> {
    return undefined
  }

  static make(accounts: readonly Account[], existing: ProviderRuntime[], read: (account: Account) => ProviderSnapshot): ProviderRuntime[] {
    const saved = new Map<string, DemoProviderRuntime>()
    for (const runtime of existing) {
      if (runtime instanceof DemoProviderRuntime && !saved.has(runtime.account.id)) saved.set(runtime.account.id, runtime)
    }
    return accounts.map((account) => {
      const runtime = saved.get(account.id)
      if (!runtime) return new DemoProviderRuntime(account, read)
      runtime.account = account
      return runtime
    })
  }
}
