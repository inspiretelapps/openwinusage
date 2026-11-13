import { useState, type ReactNode } from 'react'
import { Provider } from '@core/models/Provider'
import { ModelFigure, UsageBreakdown, UsageWindow, type UsageBreakdownTokenPart } from '@core/models/UsageHistory'
import { MetricFormatter } from '@core/support/MetricFormatter'
import type { Instant } from '@core/support/time'
import { CapsuleSegments, Spinner } from '../../components/Controls'
import { ProviderIcon } from '../../components/ProviderIcon'
import { CopyFeedbackButton } from './CopyFeedbackButton'
import type { AccountStatus } from './DashboardProviderSection'

export type UsageBreakdownDetailContent =
  | { type: 'reported'; breakdown: UsageBreakdown }
  /** The row's total is a saved one and its breakdown has not been read yet. */
  | { type: 'saved'; window: UsageWindow; figures: string[]; status: AccountStatus; date?: Instant }

/** `date.formatted(date: .abbreviated, time: .shortened)`: `Nov 3, 2026 at 9:41 AM`. */
function savedDateText(date: Instant): string {
  const day = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date)
  const time = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(date).replace(/[  ]/g, ' ')
  return `${day} at ${time}`
}

/** A history row's hover detail, and what its copy button puts on the clipboard. */
export function UsageBreakdownDetail(props: {
  content: UsageBreakdownDetailContent
  provider: Provider
  animates?: boolean
  /** The stored choice of what Top Models shows. */
  figure: ModelFigure
  onPickFigure: (figure: ModelFigure) => void
  onCopy: (breakdown: UsageBreakdown, figure: ModelFigure) => Promise<boolean>
}): ReactNode {
  const { content } = props
  const [copied, setCopied] = useState(false)
  let detail: ReactNode
  if (content.type === 'reported') {
    detail = (
      <UsageBreakdownContent
        breakdown={content.breakdown}
        provider={props.provider}
        figure={props.figure}
        onPickFigure={props.onPickFigure}
        animates={props.animates ?? true}
      />
    )
  } else {
    const saved = content.date !== undefined ? `Saved ${savedDateText(content.date)}` : 'Saved Total'
    detail = (
      <div className="ub-details">
        <UsageSummary title={`${UsageWindow.title(content.window)} · ${saved}`} figures={content.figures} />
        {content.status.refreshing ? (
          <div className="ub-loading">
            <Spinner size={16} />
            <span>Loading Breakdown…</span>
          </div>
        ) : (
          <div className="ub-unavailable">
            <span className="ub-unavailable-title">Breakdown Unavailable</span>
            <span className="ub-unavailable-reason secondary">
              {content.status.notice ?? content.status.staleness ?? 'Refresh to load the details for this range.'}
            </span>
          </div>
        )}
      </div>
    )
  }
  const breakdown = content.type === 'reported' && !UsageBreakdown.isEmpty(content.breakdown) ? content.breakdown : undefined
  return (
    <div className="ub-detail">
      {detail}
      {breakdown ? (
        <span className="ub-copy">
          <CopyFeedbackButton
            accessibilityLabel={`Copy ${UsageBreakdown.archivedTitle(breakdown) ?? UsageWindow.title(breakdown.window)} Usage`}
            copied={copied}
            setCopied={setCopied}
            action={() => props.onCopy(breakdown, props.figure)}
          />
        </span>
      ) : null}
    </div>
  )
}

export function UsageBreakdownContent(props: {
  breakdown: UsageBreakdown
  provider: Provider
  figure: ModelFigure
  /** Leave it out where nothing can be clicked, as in a picture, and the switch isn't drawn. */
  onPickFigure?: (figure: ModelFigure) => void
  animates?: boolean
}): ReactNode {
  const { breakdown, provider, onPickFigure } = props
  const title = UsageBreakdown.archivedTitle(breakdown) ?? UsageWindow.title(breakdown.window)

  if (UsageBreakdown.isEmpty(breakdown)) {
    return (
      <div className="ub-nothing">
        <div className="ub-title secondary truncate">{title}</div>
        <div className="ub-nothing-body">
          <span className={`ub-nothing-mark${props.animates ? ' is-animated' : ''}`} aria-hidden>
            <ProviderIcon id={Provider.icon(provider)} side={24} inset={0.04} />
          </span>
          <div className="ub-nothing-text">{Provider.displayName(provider)} didn't report any data for this range.</div>
        </div>
      </div>
    )
  }

  const figures = UsageBreakdown.modelFigures(breakdown)
  // The stored choice, unless this range can't show it.
  const shownFigure = figures.includes(props.figure) ? props.figure : (figures[0] ?? props.figure)
  const tokenParts = UsageBreakdown.tokenParts(breakdown)
  return (
    <div className="ub-details">
      <UsageSummary title={title} figures={UsageBreakdown.figures(breakdown)} />
      {tokenParts.length > 0 ? <TokenMix parts={tokenParts} fillsTotal={UsageBreakdown.tokenPartsFillTotal(breakdown)} /> : null}
      {figures.length > 0 ? (
        <div className="ub-models">
          <div className="ub-models-header">
            <span className="ub-title secondary" role="heading" aria-level={3}>
              Top Models
            </span>
            <span style={{ flex: 1 }} />
            {onPickFigure && figures.length > 1 ? (
              <CapsuleSegments
                options={figures.map((figure) => ({ value: figure, label: ModelFigure.label(figure) }))}
                selection={shownFigure}
                onSelect={onPickFigure}
                height={22}
                fontSize={11}
                segmentWidth={48}
                style={{ flex: 'none' }}
              />
            ) : null}
          </div>
          <div className="ub-model-list">
            {UsageBreakdown.models(breakdown, shownFigure).map((model) => {
              const number = UsageBreakdown.modelNumber(model, shownFigure)
              return (
                <div key={model.name} className="ub-model">
                  <span className="truncate">{model.name}</span>
                  <span style={{ flex: 1 }} />
                  {number !== undefined ? <span className="ub-model-number mono-digits">{ModelFigure.text(shownFigure, number)}</span> : null}
                </div>
              )
            })}
          </div>
        </div>
      ) : null}
    </div>
  )
}

function UsageSummary({ title, figures }: { title: string; figures: string[] }): ReactNode {
  return (
    <div className="ub-summary">
      <div className="ub-title secondary truncate">{title}</div>
      {figures.length > 0 ? <div className="ub-headline mono-digits truncate">{figures[0]}</div> : null}
      {figures.length > 1 ? <div className="ub-subfigures secondary mono-digits truncate">{figures.slice(1).join(' · ')}</div> : null}
    </div>
  )
}

const shades = [1, 0.6, 0.35, 0.2, 0.12]

function shade(index: number): string {
  const share = shades[Math.min(index, shades.length - 1)]
  return `color-mix(in srgb, var(--blue) ${share * 100}%, transparent)`
}

/** The kinds of token in a window, in a bar when they add up to its total. */
function TokenMix({ parts, fillsTotal }: { parts: UsageBreakdownTokenPart[]; fillsTotal: boolean }): ReactNode {
  const split = Math.floor((parts.length + 1) / 2)
  const indices = parts.map((_, index) => index)
  // Sized to its widest row, so the names and numbers of both columns always fit whole.
  const legend = (shown: number[]): ReactNode => (
    <div className="ub-legend">
      {shown.map((index) => (
        <div key={parts[index].title} className="ub-legend-row">
          <span className="ub-legend-dot" style={{ background: shade(index) }} />
          <span className="secondary">{parts[index].title}</span>
          <span style={{ flex: 1, minWidth: 6 }} />
          <span className="mono-digits">{MetricFormatter.number(parts[index].number, 'count', 'row')}</span>
        </div>
      ))}
    </div>
  )
  return (
    <div className="ub-token-mix">
      {fillsTotal ? (
        <div className="ub-token-bar" aria-hidden>
          {parts.map((part, index) => (
            <span key={part.title} style={{ flexGrow: part.number, background: shade(index) }} />
          ))}
        </div>
      ) : null}
      <div className="ub-legends">
        {legend(indices.slice(0, split))}
        <span style={{ flex: 1 }} />
        {legend(indices.slice(split))}
      </div>
    </div>
  )
}
