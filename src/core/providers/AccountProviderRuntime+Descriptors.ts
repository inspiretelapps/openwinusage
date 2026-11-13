import type { Account } from '../models/Account'
import { HistoryRow } from '../models/HistoryRow'
import { LimitResourceSource } from '../models/LimitResourceDescriptor'
import { Provider } from '../models/Provider'
import { UsageWindow } from '../models/UsageHistory'
import { WidgetDescriptor } from '../models/WidgetDescriptor'
import { AntigravityMetric } from './antigravity/AntigravityMetric'
import { CursorUsageMapper } from './cursor/CursorUsageMapper'

function rateLimitResets(key: string, provider: Provider): WidgetDescriptor {
  return WidgetDescriptor.values({
    key,
    provider,
    title: 'Limit Resets',
    metricLabel: 'Rate Limit Resets',
    showsResetExpiries: true
  }).exportingLimit('rateLimitResets', { kind: 'balance', unit: 'resets', source: LimitResourceSource.value('count', 'available') })
}

/** The metrics an account can show, in the provider's order. `metricLabel` is the label of the line each reads. */
export function widgetDescriptors(account: Account): WidgetDescriptor[] {
  const provider = Provider.forAccount(account)
  const percent = WidgetDescriptor.percent
  const values = WidgetDescriptor.values
  const boundedDollars = WidgetDescriptor.boundedDollars
  const boundedCount = WidgetDescriptor.boundedCount
  const history = (key: string, row: HistoryRow): WidgetDescriptor => HistoryRow.descriptor(key, provider, row)
  const { today, yesterday, thisWeek, thisMonth } = UsageWindow

  switch (account.kind) {
    case 'claude':
      return [
        percent({ key: 'session', provider, title: 'Session', sessionStartSignal: 'missingResetDate' }).exportingLimit('session', { unit: 'percent' }),
        percent({ key: 'weekly', provider, title: 'Weekly' }).exportingLimit('weekly', { unit: 'percent' }),
        percent({ key: 'sonnet', provider, title: 'Sonnet' }).exportingLimit('sonnet', { unit: 'percent' }),
        percent({ key: 'fable', provider, title: 'Fable' }).exportingLimit('fable', { unit: 'percent' }),
        boundedDollars({ key: 'extra', provider, title: 'Extra Usage', metricLabel: 'Extra usage spent', limit: 100, valueWord: 'spent' }).exportingLimit(
          'extraUsage',
          { unit: 'usd', source: LimitResourceSource.progressOrValue('dollars') }
        ),
        rateLimitResets('rateLimitResets', provider)
      ]
    case 'codex':
      return [
        percent({ key: 'session', provider, title: 'Session' }).exportingLimit('session', { unit: 'percent' }),
        percent({ key: 'weekly', provider, title: 'Weekly' }).exportingLimit('weekly', { unit: 'percent' }),
        percent({ key: 'spark', provider, title: 'Spark' }).exportingLimit('spark', { unit: 'percent' }),
        percent({ key: 'sparkWeekly', provider, title: 'Spark Weekly' }).exportingLimit('sparkWeekly', { unit: 'percent' }),
        values({ key: 'credits', provider, title: 'Extra Usage', metricLabel: 'Credits' }).exportingLimit('credits', {
          kind: 'balance',
          unit: 'credits',
          source: LimitResourceSource.value('count', 'credits')
        }),
        boundedCount({ key: 'creditLimit', provider, title: 'Credit Limit', limit: 0 }),
        rateLimitResets('rateLimitResets', provider),
        history('today', HistoryRow.window(today, 'tokens')),
        history('yesterday', HistoryRow.window(yesterday, 'tokens')),
        history('last30', HistoryRow.window(UsageWindow.lastDays(30), 'tokens'))
      ]
    case 'cursor':
      return [
        percent({ key: 'usage', provider, title: 'Total Usage', metricLabel: 'Total usage' }).exportingLimit('totalUsage', { unit: 'percent' }),
        percent({ key: 'auto', provider, title: 'Cursor Models' }).exportingLimit('autoUsage', { unit: 'percent' }),
        percent({ key: 'api', provider, title: 'Other Models' }).exportingLimit('apiUsage', { unit: 'percent' }),
        boundedDollars({ key: 'onDemand', provider, title: 'Extra Usage', metricLabel: 'On-demand', limit: 100, valueWord: 'spent' }).exportingLimit(
          'onDemand',
          { unit: 'usd', source: LimitResourceSource.progressOrValue('dollars') }
        ),
        percent({ key: 'grokBot', provider, title: 'Grok Bot', metricLabel: 'Grok Bot usage' }).exportingLimit('grokBot', { unit: 'percent' }),
        boundedCount({ key: 'requests', provider, title: 'Requests', limit: 500, periodDurationMs: CursorUsageMapper.billingPeriodMs }).exportingLimit(
          'requests',
          { unit: 'requests' }
        ),
        values({ key: 'credits', provider, title: 'Credits', valueWord: 'left' }).exportingLimit('credits', {
          kind: 'balance',
          unit: 'usd',
          source: LimitResourceSource.value('dollars')
        }),
        history('today', HistoryRow.window(today, 'spend', 'tokens')),
        history('yesterday', HistoryRow.window(yesterday, 'spend', 'tokens')),
        history('last30', HistoryRow.window(UsageWindow.lastDays(30), 'spend', 'tokens'))
      ]
    case 'antigravity':
      return [
        percent({ key: 'geminiPro', provider, title: 'Gemini 5h', metricLabel: AntigravityMetric.sessionLabel, sessionStartSignal: 'zeroUsage' }).exportingLimit(
          'geminiSession',
          { unit: 'percent' }
        ),
        percent({ key: 'geminiWeekly', provider, title: 'Gemini', metricLabel: AntigravityMetric.weeklyLabel }).exportingLimit('geminiWeekly', {
          unit: 'percent'
        }),
        percent({ key: 'argonWeekly', provider, title: 'Argon', metricLabel: AntigravityMetric.argonWeeklyLabel }).exportingLimit('argonWeekly', {
          unit: 'percent'
        }),
        percent({ key: 'claude', provider, title: 'Claude 5h', metricLabel: AntigravityMetric.claudeLabel, sessionStartSignal: 'zeroUsage' }).exportingLimit(
          'nonGeminiSession',
          { unit: 'percent' }
        ),
        percent({ key: 'claudeWeekly', provider, title: 'Claude', metricLabel: AntigravityMetric.claudeWeeklyLabel }).exportingLimit('nonGeminiWeekly', {
          unit: 'percent'
        })
      ]
    case 'copilot':
      if (account.organization !== undefined) {
        return [
          values({ key: 'orgCredits', provider, title: 'Org Credits' }).exportingLimit('orgCredits', {
            unit: 'credits',
            source: LimitResourceSource.value('count', 'credits')
          }),
          values({ key: 'orgSpend', provider, title: 'Org Spend', valueWord: 'spent' }).exportingLimit('orgSpend', {
            unit: 'usd',
            source: LimitResourceSource.value('dollars')
          })
        ]
      }
      return [
        percent({ key: 'premium', provider, title: 'Credits', metricLabel: 'Credits' }).exportingLimit('premiumCredits', {
          unit: 'credits',
          source: LimitResourceSource.progressOrValue('count')
        }),
        values({ key: 'extra', provider, title: 'Extra Usage' }).exportingLimit('extraUsage', { unit: 'count', source: LimitResourceSource.value('count') }),
        boundedCount({ key: 'chat', provider, title: 'Chat', limit: 0 }).exportingLimit('chat', { unit: 'percent' }),
        boundedCount({ key: 'completions', provider, title: 'Completions', limit: 0 }).exportingLimit('completions', { unit: 'percent' })
      ]
    case 'devin':
      return [
        percent({ key: 'daily', provider, title: 'Daily', metricLabel: 'Daily quota' }).exportingLimit('daily', { unit: 'percent' }),
        percent({ key: 'weekly', provider, title: 'Weekly', metricLabel: 'Weekly quota' }).exportingLimit('weekly', { unit: 'percent' }),
        values({ key: 'extra', provider, title: 'Extra Usage', metricLabel: 'Extra usage balance', valueWord: 'left' }).exportingLimit('extraUsageBalance', {
          kind: 'balance',
          unit: 'usd',
          source: LimitResourceSource.value('dollars')
        })
      ]
    case 'grok':
      return [
        percent({ key: 'weekly', provider, title: 'Weekly', metricLabel: 'Weekly limit' }).exportingLimit('weekly', { unit: 'percent' }),
        WidgetDescriptor.badge({ key: 'payAsYouGo', provider, title: 'Extra Usage', metricLabel: 'Pay as you go' })
      ]
    case 'muse':
      return [
        percent({ key: 'session', provider, title: 'Session', sessionStartSignal: 'missingResetDate' }).exportingLimit('session', { unit: 'percent' }),
        percent({ key: 'weekly', provider, title: 'Weekly' }).exportingLimit('weekly', { unit: 'percent' })
      ]
    case 'ollama':
      return [
        percent({ key: 'session', provider, title: 'Session' }).exportingLimit('session', { unit: 'percent' }),
        percent({ key: 'weekly', provider, title: 'Weekly' }).exportingLimit('weekly', { unit: 'percent' }),
        percent({ key: 'monthly', provider, title: 'Monthly' }).exportingLimit('monthly', { unit: 'percent' }),
        values({ key: 'purchasedCredits', provider, title: 'Extra Usage', metricLabel: 'Purchased Credits', valueWord: 'left' }).exportingLimit(
          'purchasedCredits',
          { kind: 'balance', unit: 'usd', source: LimitResourceSource.value('dollars') }
        ),
        history('today', HistoryRow.window(today, 'usageValue', 'tokens')),
        history('yesterday', HistoryRow.window(yesterday, 'usageValue', 'tokens')),
        history('last30', HistoryRow.window(UsageWindow.lastDays(30), 'usageValue', 'tokens')),
        history('requests', HistoryRow.measure('Requests', 'requests', UsageWindow.lastDays(30)))
      ]
    case 'opencode':
      return [
        percent({ key: 'session', provider, title: 'Session', sessionStartSignal: 'missingResetDate' }).exportingLimit('session', { unit: 'percent' }),
        percent({ key: 'weekly', provider, title: 'Weekly' }).exportingLimit('weekly', { unit: 'percent' }),
        percent({ key: 'monthly', provider, title: 'Monthly' }).exportingLimit('monthly', { unit: 'percent' })
      ]
    case 'openrouter':
      return [
        values({ key: 'balance', provider, title: 'Balance', valueWord: 'left' }).exportingLimit('balance', {
          kind: 'balance',
          unit: 'usd',
          source: LimitResourceSource.value('dollars')
        }),
        history('today', HistoryRow.window(today, 'spend')),
        history('yesterday', HistoryRow.window(yesterday, 'spend')),
        history('week', HistoryRow.window(thisWeek, 'spend')),
        history('month', HistoryRow.window(thisMonth, 'spend')),
        history('prior30', HistoryRow.window(UsageWindow.priorDays(30), 'spend')),
        boundedDollars({ key: 'keyLimit', provider, title: 'Key Limit', limit: 100 }).exportingLimit('keyLimit', { unit: 'usd' }),
        boundedDollars({ key: 'budget', provider, title: 'Budget', limit: 100 }),
        boundedCount({ key: 'freeRequests', provider, title: 'Free Requests', limit: 50 })
      ]
    case 'zai':
      return [
        percent({ key: 'session', provider, title: 'Session' }).exportingLimit('session', { unit: 'percent' }),
        percent({ key: 'weekly', provider, title: 'Weekly' }).exportingLimit('weekly', { unit: 'percent' }),
        boundedCount({ key: 'webSearches', provider, title: 'Web Searches', limit: 0 }).exportingLimit('webSearches', { unit: 'searches' }),
        rateLimitResets('rateLimitResets', provider)
      ]
  }
}
