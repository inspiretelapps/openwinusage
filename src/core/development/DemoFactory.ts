import { Account, ProviderKind } from '../models/Account'
import { HistoryRow } from '../models/HistoryRow'
import type { LimitResourceDescriptor } from '../models/LimitResourceDescriptor'
import type { MetricKind } from '../models/MetricKind'
import { MetricLine, ProgressFormat } from '../models/MetricLine'
import type { MetricValue } from '../models/MetricValue'
import { Provider } from '../models/Provider'
import { ProviderSnapshot } from '../models/ProviderSnapshot'
import { UsageHistory, UsageTotals, type UsageMeasure } from '../models/UsageHistory'
import type { WidgetDescriptor } from '../models/WidgetDescriptor'
import { widgetDescriptors } from '../providers/AccountProviderRuntime+Descriptors'
import { CodexUsageMapper } from '../providers/codex/CodexUsageMapper'
import { Calendar } from '../support/Calendar'
import { MetricPeriod } from '../support/MetricPeriod'
import { rounded } from '../support/numbers'
import { addSeconds, type Instant, type Seconds } from '../support/time'
import type { DemoRandom } from './DemoRandom'

export interface DemoEntry {
  kind: ProviderKind
  label: string
  organization?: string
}

/** The limit states every shuffle shows at least once, the most particular first. */
type Scenario = 'emptyBalance' | 'useItOrLoseIt' | 'burningFast' | 'usedUp' | 'critical' | 'warning'
const scenarios: Scenario[] = ['emptyBalance', 'useItOrLoseIt', 'burningFast', 'usedUp', 'critical', 'warning']

const hour: Seconds = 3600
const day: Seconds = 24 * hour
const week: Seconds = 7 * day

const names = ['Work', 'Personal', 'Side Project', 'Team', 'Client Work', 'Research']
const longNames = ['Platform Engineering Shared Account', 'Experimental Agents Sandbox (Do Not Delete)', 'Customer Success Automation Team']

function email(random: DemoRandom): string {
  const name = random.element(['alex', 'sam', 'maya', 'jordan', 'priya', 'leo', 'nina', 'omar'])
  return `${name}@${random.element(['example.com', 'example.org', 'example.net'])}`
}

function period(descriptor: WidgetDescriptor): Seconds {
  if (descriptor.sample.periodDurationMs !== undefined) return descriptor.sample.periodDurationMs / 1000
  const key = descriptor.key.toLowerCase()
  let milliseconds: number
  if (key === 'session' || ['geminipro', 'claude', 'spark'].includes(key)) milliseconds = MetricPeriod.sessionMs
  else if (key === 'daily' || key === 'freerequests') milliseconds = MetricPeriod.dayMs
  else if (key.includes('weekly') || ['sonnet', 'fable'].includes(key)) milliseconds = MetricPeriod.weekMs
  else milliseconds = MetricPeriod.monthMs
  return milliseconds / 1000
}

function fits(scenario: Scenario, descriptor: WidgetDescriptor): boolean {
  if (scenario === 'emptyBalance') {
    return !descriptor.sample.showsResetExpiries && descriptor.limitResources.some((resource) => resource.kind === 'balance')
  }
  if (descriptor.sample.limit === undefined) return false
  switch (scenario) {
    case 'useItOrLoseIt':
      return descriptor.sample.kind !== 'dollars' && period(descriptor) > day
    case 'burningFast':
      return period(descriptor) <= week
    default:
      return true
  }
}

function values(descriptor: WidgetDescriptor, resource: LimitResourceDescriptor, isEmpty: boolean, random: DemoRandom): MetricValue[] {
  if (descriptor.providerKind === 'codex' && descriptor.key === 'credits') {
    return CodexUsageMapper.creditValues(isEmpty ? 0 : random.double(50, 5000))
  }
  let kind: MetricKind
  let label: string | undefined
  if (resource.source.type === 'progress') kind = descriptor.sample.kind
  else {
    kind = resource.source.kind
    label = resource.source.label
  }
  let number: number
  if (isEmpty) number = 0
  else if (kind === 'dollars') number = rounded(random.double(1, 250) * 100) / 100
  else number = rounded(random.double(10, 20_000))
  const value: MetricValue = { number, kind }
  if (label !== undefined) value.label = label
  return [value]
}

function line(descriptor: WidgetDescriptor, scenario: Scenario | undefined, now: Instant, random: DemoRandom): MetricLine {
  const label = descriptor.metricLabel
  if (descriptor.sample.showsResetExpiries) {
    const count = random.intThrough(1, 3)
    const expiries = Array.from({ length: count }, () => addSeconds(now, random.double(hour, week))).sort((a, b) => a - b)
    return MetricLine.values(label, [{ number: expiries.length, kind: 'count', label: 'available' }], expiries)
  }
  const sampleLimit = descriptor.sample.limit
  if (sampleLimit === undefined) {
    const resource = descriptor.limitResources[0]
    if (!resource) return MetricLine.badge(label, 'Enabled')
    return MetricLine.values(label, values(descriptor, resource, scenario === 'emptyBalance', random))
  }
  const windowLength = period(descriptor)
  const latest = Math.min(windowLength, week)
  let untilReset: Seconds
  if (scenario === 'burningFast') untilReset = windowLength * random.double(0.6, 0.85)
  else if (scenario === 'useItOrLoseIt') untilReset = random.double(2 * hour, 20 * hour)
  else untilReset = random.double(Math.min(hour, latest), latest)

  let share: number
  switch (scenario) {
    case 'usedUp':
      share = 1
      break
    case 'critical':
      share = random.double(0.91, 0.97)
      break
    case 'warning':
      share = random.double(0.72, 0.87)
      break
    // At most 40% of the window gone with about half used: well over the limit by the reset.
    case 'burningFast':
      share = random.double(0.45, 0.65)
      break
    case 'useItOrLoseIt':
      share = random.double(0.1, 0.4)
      break
    // At an even pace or slower, so a limit burns fast only where a scenario puts it.
    default:
      share = (1 - untilReset / windowLength) * random.double(0.2, 0.95)
  }
  let limit: number
  if (descriptor.sample.kind === 'dollars') limit = random.element([20, 50, 100, 200])
  else if (descriptor.sample.kind === 'count' && sampleLimit === 0) limit = random.element([50, 100, 1000, 2000])
  else limit = sampleLimit
  const format: ProgressFormat =
    descriptor.sample.kind === 'percent' ? ProgressFormat.percent : descriptor.sample.kind === 'dollars' ? ProgressFormat.dollars : ProgressFormat.count('')
  const used = descriptor.sample.kind === 'dollars' ? rounded(limit * share * 100) / 100 : rounded(limit * share)
  return MetricLine.progress(label, used, limit, format, addSeconds(now, untilReset), Math.trunc(windowLength * 1000))
}

function plans(account: Account): string[] {
  switch (account.kind) {
    case 'claude':
      return ['Pro', 'Max', 'Ultra']
    case 'codex':
      return ['Plus', 'Pro', 'Business']
    case 'cursor':
      return ['Pro', 'Pro+', 'Ultra']
    case 'antigravity':
      return ['AI Pro', 'AI Ultra']
    case 'copilot':
      return account.organization === undefined ? ['Free', 'Pro', 'Pro+'] : ['Business', 'Enterprise']
    case 'devin':
      return ['Core', 'Team']
    case 'grok':
      return ['SuperGrok', 'SuperGrok Heavy']
    case 'muse':
      return ['Free', 'Pro']
    case 'ollama':
      return ['Free', 'Pro', 'Max']
    case 'opencode':
      return ['Go']
    case 'openrouter':
      return ['Pay As You Go']
    case 'zai':
      return ['Lite', 'Pro', 'Max']
  }
}

function history(now: Instant, random: DemoRandom): UsageHistory {
  const calendar = Calendar.current
  const sample = UsageHistory.make(calendar, now)
  const scale = random.double(0.3, 3)
  for (const dayStart of UsageHistory.dayStartsBack(31, now, calendar)) {
    const activity = scale * random.double(0, 1.5)
    const totals: Partial<Record<UsageMeasure, number>> = {
      spend: 2.4 * activity,
      usageValue: 1.8 * activity,
      credits: 60 * activity,
      requests: rounded(128 * activity),
      usageEvents: rounded(144 * activity),
      turns: rounded(24 * activity),
      tokens: 1_280_000 * activity,
      inputTokens: 740_000 * activity,
      cacheReadTokens: 280_000 * activity,
      outputTokens: 260_000 * activity
    }
    const scaled = (factor: number): UsageTotals =>
      UsageTotals.make(Object.fromEntries(Object.entries(totals).map(([measure, number]) => [measure, (number as number) * factor])))
    sample.days.set(dayStart, {
      totals: UsageTotals.make(totals),
      byModel: { 'Sample Model A': scaled(0.6), 'Sample Model B': scaled(0.4) }
    })
  }
  return sample
}

/** Random sample accounts and readings, shaped by each provider's real metric descriptors. */
export const DemoFactory = {
  /** Every provider in a random order, each with one to three accounts. */
  accounts(random: DemoRandom): DemoEntry[] {
    const entries: DemoEntry[] = []
    for (const kind of random.shuffled(ProviderKind.allCases)) {
      const count = random.element([1, 1, 1, 2, 2, 3])
      for (let index = 0; index < count; index++) {
        if (kind === 'copilot' && random.int(0, 3) === 0) {
          const organization = random.element(['acme-labs', 'northwind', 'globex-research'])
          entries.push({ kind, label: organization, organization })
        } else {
          entries.push({ kind, label: random.bool() ? email(random) : random.element(names) })
        }
      }
    }
    const personal = random.shuffled(entries.map((_, index) => index).filter((index) => entries[index].organization === undefined))
    entries[personal[0]].label = random.element(longNames)
    entries[personal[1]].label = email(random)
    return entries
  },

  /** One reading per account, keyed by account id. Each scenario lands on a random limit that can show it, and one account carries a notice. */
  snapshots(accounts: readonly Account[], now: Instant, random: DemoRandom): Map<string, ProviderSnapshot> {
    const descriptors = accounts.map((account) => widgetDescriptors(account))
    const limits = descriptors.flatMap((list) => list.filter((descriptor) => descriptor.historyRow === undefined))
    const chosen = new Map<string, Scenario>()
    for (const scenario of scenarios) {
      const open = limits.filter((descriptor) => !chosen.has(descriptor.id) && fits(scenario, descriptor))
      const pick = random.optionalElement(open)
      if (pick) chosen.set(pick.id, scenario)
    }
    const noticed = accounts.length === 0 ? undefined : random.int(0, accounts.length)
    const snapshots = new Map<string, ProviderSnapshot>()
    accounts.forEach((account, index) => {
      const lines: MetricLine[] = []
      descriptors[index].forEach((descriptor, position) => {
        if (descriptor.historyRow !== undefined) return
        const scenario = chosen.get(descriptor.id)
        // Providers report some metrics only on some plans, so after the first each one shows two times in three.
        if (!(position === 0 || scenario !== undefined || random.int(0, 3) > 0)) return
        lines.push(line(descriptor, scenario, now, random))
      })
      const snapshot = ProviderSnapshot.forProvider(
        Provider.forAccount(account),
        random.optionalElement(plans(account)),
        lines,
        index === noticed ? 'The provider is reporting delayed usage for this account.' : undefined,
        now
      )
      if (descriptors[index].some((descriptor) => descriptor.historyRow !== undefined)) {
        HistoryRow.append(snapshot, descriptors[index], history(now, random))
      }
      snapshots.set(account.id, snapshot)
    })
    return snapshots
  }
}
