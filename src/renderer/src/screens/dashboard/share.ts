import { createElement } from 'react'
import { DashboardAccount, type DashboardFamily } from '@core/models/DashboardFamilies'
import { PriorityBoard } from '@core/models/PriorityBoard'
import type { Provider } from '@core/models/Provider'
import type { ModelFigure, UsageBreakdown } from '@core/models/UsageHistory'
import type { ProviderMetrics } from '@core/stores/LayoutStoreModels'
import type { Stores } from '../../state/stores'
import { ShareCardRenderer } from './ShareCardRenderer'
import { PriorityShareCard, ShareCardView, UsageBreakdownShareCard } from './ShareCardView'

/**
 * Copies the Priority tab as a picture. It reads the live board when called. Emails are left out,
 * or with Privacy Mode on every account name is blurred. Answers whether a picture was copied.
 */
export async function copyPriorityShareCard(stores: Stores): Promise<boolean> {
  const now = Date.now()
  const blursAccountNames = stores.state.privacyMode.isEnabled
  const board = stores.data.priorityBoard(stores.layout.displayGroups, stores.layout.state.priorityPinIDs, now, !blursAccountNames)
  if (!PriorityBoard.hasRows(board)) return false
  return ShareCardRenderer.copy(createElement(PriorityShareCard, { board, now, appName: stores.state.app.name, blursAccountNames }), 'priority')
}

/**
 * Copies a provider's card as a picture, holding only `accountIDs` of its accounts: all of them from
 * the card's own button, one from an account's Share Screenshot. `groups` is the order on screen, when
 * it is ahead of the stores'.
 */
export async function copyProviderShareCard(stores: Stores, accountIDs: string[], groups: ProviderMetrics[] = stores.layout.displayGroups): Promise<boolean> {
  const live = stores.data.families(groups).find((family) => family.accounts.some((account) => accountIDs.includes(DashboardAccount.id(account))))
  if (!live) return false
  const accounts = live.accounts.filter((account) => accountIDs.includes(DashboardAccount.id(account)))
  const family: DashboardFamily = { id: live.id, provider: accounts[0].provider, accounts }
  const plans: Record<string, string> = {}
  for (const account of accounts) {
    const plan = stores.data.plan(DashboardAccount.id(account))
    if (plan !== undefined) plans[DashboardAccount.id(account)] = plan
  }
  return ShareCardRenderer.copy(
    createElement(ShareCardView, { family, plans, appName: stores.state.app.name, blursAccountNames: stores.state.privacyMode.isEnabled }),
    family.id
  )
}

/** Copies a usage window's detail as a picture, showing Top Models by `figure`. */
export async function copyUsageBreakdownShareCard(
  stores: Stores,
  provider: Provider,
  breakdown: UsageBreakdown,
  figure: ModelFigure,
  name: string
): Promise<boolean> {
  return ShareCardRenderer.copy(createElement(UsageBreakdownShareCard, { provider, breakdown, figure, appName: stores.state.app.name }), name)
}
