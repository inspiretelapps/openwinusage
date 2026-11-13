import { DashboardAccount, type DashboardLine } from '@core/models/DashboardFamilies'
import type { Provider } from '@core/models/Provider'
import { WidgetData } from '@core/models/WidgetData'
import { WidgetDescriptor } from '@core/models/WidgetDescriptor'
import { Calendar } from '@core/support/Calendar'

function descriptor(key: string, provider: Provider, title: string, data: WidgetData): WidgetDescriptor {
  return new WidgetDescriptor(provider, key, title, data)
}

function percent(key: string, provider: Provider, title: string, used: number): WidgetDescriptor {
  return descriptor(key, provider, title, new WidgetData({ title, kind: 'percent', used, limit: 100 }))
}

function countBounded(key: string, provider: Provider, title: string, used: number, limit: number): WidgetDescriptor {
  return descriptor(key, provider, title, new WidgetData({ title, kind: 'count', used, limit }))
}

function amount(key: string, provider: Provider, title: string, used: number): WidgetDescriptor {
  return descriptor(key, provider, title, new WidgetData({ title, kind: 'dollars', used, limit: undefined }))
}

const claude: Provider = { id: 'claude', kind: 'claude' }
const codex: Provider = { id: 'codex', kind: 'codex' }
const cursor: Provider = { id: 'cursor', kind: 'cursor' }

const descriptors: WidgetDescriptor[] = [
  percent('session', claude, 'Session', 0),
  percent('weekly', claude, 'Weekly', 34),
  amount('extra', claude, 'Extra usage', 217.59),
  amount('today', claude, 'Today', 64.2),

  percent('session', codex, 'Session', 80),
  percent('weekly', codex, 'Weekly', 20),
  countBounded('credits', codex, 'Extra Usage', 320, 1000),
  amount('today', codex, 'Today', 569.09),

  percent('usage', cursor, 'Usage', 98),
  amount('credits', cursor, 'Credits', 12.48),
  countBounded('requests', cursor, 'Requests', 412, 500),
  amount('today', cursor, 'Today', 12.48)
]

/** Upstream's `MockData`. */
export const MockData = {
  claude,
  codex,
  cursor,
  providers: [claude, codex, cursor] as Provider[],
  descriptors,

  descriptorsFor(providerID: string): WidgetDescriptor[] {
    return descriptors.filter((candidate) => candidate.providerID === providerID)
  }
}

/**
 * The `account(_:_:)` helper several upstream test files define: an account whose lines are each keyed
 * and labelled by their title, with the reading as the descriptor's sample.
 */
export function accountOf(provider: Provider, ...lines: WidgetData[]): DashboardAccount {
  return DashboardAccount.make(
    provider,
    lines.map((data): DashboardLine => ({ descriptor: new WidgetDescriptor(provider, data.title, data.title, data), data }))
  )
}

/**
 * Runs `body` with the machine's time zone set to `timeZone`, handing it a fresh local calendar: the
 * port's stand-in for a Foundation `Calendar` built with `TimeZone(identifier:)`. The port's `Calendar`
 * is either the machine's zone or UTC, as upstream's own code only ever uses those two.
 */
export function withTimeZone<T>(timeZone: string, body: (calendar: Calendar) => T): T {
  const saved = process.env.TZ
  process.env.TZ = timeZone
  try {
    return body(new Calendar('local', 1))
  } finally {
    if (saved === undefined) delete process.env.TZ
    else process.env.TZ = saved
  }
}
