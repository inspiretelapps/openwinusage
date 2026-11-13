import type { ReactNode } from 'react'
import { DashboardRowModel } from '@core/models/DashboardRowModel'
import type { MeterSeverity } from '@core/models/WidgetData'
import { Tooltip } from '../../components/Tooltip'
import { LevelIndicator } from './LevelIndicator'

/** A figure keeps the row's colour until it warns; an amount is secondary until it does. */
function severityClass(severity: MeterSeverity): string {
  return severity === 'normal' ? '' : ` is-${severity}`
}

export function expiryAccessibilityValue(severity: MeterSeverity): string | undefined {
  switch (severity) {
    case 'normal':
      return undefined
    case 'warning':
      return 'a reset expires within 7 days'
    case 'critical':
      return 'a reset expires within 48 hours'
  }
}

/**
 * One metric: a limit as label, bar, amount, and reset, or an open figure as label and value.
 * Without its handlers nothing can be clicked, as in a picture or a lifted preview.
 */
export function DashboardMetricRow(props: {
  model: DashboardRowModel
  onToggleMeterStyle?: () => void
  onToggleResetDisplay?: () => void
  paceTooltip?: string
  valueTooltip?: string
  resetTooltip?: string
  /** Wraps the figure of a value row, as the hover detail's trigger does. */
  figure?: (figure: ReactNode) => ReactNode
}): ReactNode {
  const { model } = props
  const mark = model.mark
  if (mark.type === 'bar') {
    const value = <span className="mono-digits">{mark.value}</span>
    const reset = <span className="mono-digits">{mark.reset ?? ''}</span>
    return (
      <div className={`db-row is-bar${DashboardRowModel.isFaded(model) ? ' is-faded' : ''}`} role="group">
        <span className="db-row-label">{model.label}</span>
        <Tooltip text={props.paceTooltip}>
          <span className="db-level-slot">
            <LevelIndicator fill={mark.fill} severity={mark.severity} paceMark={model.paceMark} />
          </span>
        </Tooltip>
        <span className={`db-row-value${severityClass(mark.severity)}`}>
          {props.onToggleMeterStyle ? (
            <Tooltip text={props.valueTooltip}>
              <button type="button" className="plain-button" onClick={props.onToggleMeterStyle}>
                {value}
              </button>
            </Tooltip>
          ) : (
            value
          )}
        </span>
        <span className={`db-row-reset${model.showsClockTimes ? ' is-clock' : ''}${mark.isUsedUp ? ' is-critical' : ''}`}>
          {/* Blank when there's no reset, so the row's bar keeps the same length as its neighbours. */}
          {mark.reset !== undefined && props.onToggleResetDisplay ? (
            <Tooltip text={props.resetTooltip}>
              <button type="button" className="plain-button" onClick={props.onToggleResetDisplay}>
                {reset}
              </button>
            </Tooltip>
          ) : (
            reset
          )}
        </span>
      </div>
    )
  }
  const figure = (
    <span className="db-figure mono-digits" aria-description={expiryAccessibilityValue(mark.severity)}>
      <span className={`db-figure-text${severityClass(mark.severity)}`}>{mark.text}</span>
      {mark.detail !== undefined ? <span className="secondary">{` · ${mark.detail}`}</span> : null}
    </span>
  )
  return (
    <div className="db-row is-value" role="group">
      <span className="db-row-label">{model.label}</span>
      <span className="db-row-spacer" />
      {props.figure ? props.figure(figure) : figure}
    </div>
  )
}
