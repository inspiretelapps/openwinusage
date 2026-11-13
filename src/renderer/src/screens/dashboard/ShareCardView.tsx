import type { ReactNode } from 'react'
import { DashboardAccount, DashboardFamily } from '@core/models/DashboardFamilies'
import type { PriorityBoard } from '@core/models/PriorityBoard'
import { Provider } from '@core/models/Provider'
import type { ModelFigure, UsageBreakdown } from '@core/models/UsageHistory'
import type { Instant } from '@core/support/time'
import { ProviderIcon } from '../../components/ProviderIcon'
import { DashboardGrid } from './DashboardGrid'
import { DashboardAccountRows, DashboardProviderSection } from './DashboardProviderSection'
import { DrawsLevelsAsShapes } from './LevelIndicator'
import { PriorityBoardList } from './PriorityDashboardView'
import { UsageBreakdownContent } from './UsageBreakdownDetail'
import './dashboard.css'

export const ShareCard = {
  width: 360,
  inset: 16
} as const

/**
 * A provider's card as a picture. It sets its own width and an opaque background, and draws in the
 * panel's current appearance.
 */
export function ShareCardView(props: {
  family: DashboardFamily
  plans?: Record<string, string>
  appName: string
  /** Privacy Mode is on: every account name blurs. Off, emails are left out. */
  blursAccountNames?: boolean
  now?: Instant
}): ReactNode {
  const { family } = props
  const blurs = props.blursAccountNames ?? false
  return (
    <ShareCardFrame appName={props.appName} blursAccountNames={blurs}>
      <DashboardProviderSection
        family={blurs ? family : DashboardFamily.hidingEmails(family)}
        account={(account) => (
          <DashboardAccountRows
            key={DashboardAccount.id(account)}
            account={account}
            plan={props.plans?.[DashboardAccount.id(account)]}
            hasSiblingAccounts={family.accounts.length > 1}
            now={props.now}
          />
        )}
      />
    </ShareCardFrame>
  )
}

/** A window's usage as a picture: the provider above the same detail its row shows on hover. */
export function UsageBreakdownShareCard(props: { provider: Provider; breakdown: UsageBreakdown; figure?: ModelFigure; appName: string }): ReactNode {
  const { provider } = props
  return (
    <ShareCardFrame appName={props.appName}>
      <div className="db-section">
        <div className="db-header">
          <span className="db-header-title truncate">{Provider.displayName(provider)}</span>
          <span className="db-header-spacer" />
          <ProviderIcon id={Provider.icon(provider)} side={DashboardGrid.iconSize} inset={0.04} />
        </div>
        <div className="card" style={{ padding: DashboardGrid.cardPadding }}>
          <UsageBreakdownContent breakdown={props.breakdown} provider={provider} figure={props.figure ?? 'cost'} />
        </div>
      </div>
    </ShareCardFrame>
  )
}

/** The Priority tab as a picture. */
export function PriorityShareCard(props: { board: PriorityBoard; now: Instant; appName: string; blursAccountNames?: boolean }): ReactNode {
  return (
    <ShareCardFrame appName={props.appName} blursAccountNames={props.blursAccountNames ?? false}>
      <PriorityBoardList board={props.board} now={props.now} />
    </ShareCardFrame>
  )
}

function ShareCardFrame(props: { appName: string; blursAccountNames?: boolean; children: ReactNode }): ReactNode {
  return (
    <DrawsLevelsAsShapes.Provider value={true}>
      <div className="share-card" data-conceals-names={props.blursAccountNames ?? false} style={{ width: ShareCard.width }}>
        <div style={{ padding: ShareCard.inset }}>{props.children}</div>
        <div className="share-card-footer">
          <ProviderIcon id="app" side={16} inset={0} style={{ color: 'var(--text)' }} />
          <span className="share-card-name">{props.appName}</span>
          <span style={{ flex: 1, minWidth: 8 }} />
          <span className="share-card-tagline secondary">Your AI Limits at a Glance</span>
        </div>
      </div>
    </DrawsLevelsAsShapes.Provider>
  )
}
