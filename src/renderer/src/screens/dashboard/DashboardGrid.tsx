import type { ReactNode } from 'react'
import type { DashboardAccount, DashboardLine } from '@core/models/DashboardFamilies'

/** The All Usage card's measurements, in points upstream and CSS pixels here. `dashboard.css` uses the same numbers. */
export const DashboardGrid = {
  cardPadding: 12,
  cardTopPadding: 8,
  cardBottomPadding: 10,
  headerGap: 4,
  sectionSpacing: 14,
  accountSpacing: 8,
  captionGap: 4,
  columnGap: 8,
  rowHeight: 22,
  levelHeight: 9,
  labelWidth: 90,
  valueWidth: 52,
  resetWidth: 48,
  clockResetWidth: 80,
  headerHeight: 24,
  /** The line height of the 11pt system font, rounded up. */
  captionHeight: 14,
  /** The cap height of the 11pt system font: the side of the hub mark beside an account's name. */
  planCapHeight: 8,
  iconSize: 16
} as const

/** An account's rows, one under the next, or a skeleton row per metric until its first reading. */
export function DashboardLineStack(props: { account: DashboardAccount; row: (line: DashboardLine) => ReactNode }): ReactNode {
  const { account } = props
  return (
    <div className="db-line-stack">
      {account.lines.map((line) => props.row(line))}
      {account.waitingMetricIDs.length > 0 ? (
        <div role="img" aria-label="Waiting for Usage">
          {account.waitingMetricIDs.map((id) => (
            <SkeletonMetricRow key={id} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** A metric row's bar, figure, and reset as grey bars in their own columns. */
function SkeletonMetricRow(): ReactNode {
  return (
    <div className="db-row is-bar skeleton" aria-hidden>
      <span className="db-row-label">
        <span className="skeleton-shape db-capsule" style={{ display: 'block', width: 54, height: 8 }} />
      </span>
      <span className="skeleton-shape db-capsule" style={{ flex: 1, height: DashboardGrid.levelHeight }} />
      <span className="db-row-value">
        <span className="skeleton-shape db-capsule" style={{ width: 30, height: 8 }} />
      </span>
      <span className="db-row-reset">
        <span className="skeleton-shape db-capsule" style={{ width: 30, height: 7 }} />
      </span>
    </div>
  )
}
