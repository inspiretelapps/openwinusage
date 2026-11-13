import { createContext, useContext, type ReactNode } from 'react'
import type { MeterSeverity } from '@core/models/WidgetData'

/**
 * Upstream's `drawsLevelsAsShapes` environment value: a share image draws its bars as plain shapes,
 * the full height of the row's level lane, where the panel draws the system's progress bar.
 */
export const DrawsLevelsAsShapes = createContext(false)

/** A limit's level as a progress bar, with a tick where it would be at an even pace. */
export function LevelIndicator(props: { fill: number; severity: MeterSeverity; paceMark?: number }): ReactNode {
  const drawsAsShapes = useContext(DrawsLevelsAsShapes)
  const fill = Math.min(Math.max(props.fill, 0), 1)
  return (
    <span className={`db-level${drawsAsShapes ? ' is-shapes' : ''}`} aria-hidden>
      <span className="db-level-track">
        {fill > 0 ? <span className={`db-level-fill is-${props.severity}`} style={{ width: `${fill * 100}%` }} /> : null}
      </span>
      {props.paceMark !== undefined ? <span className="db-pace-mark" style={{ left: `calc(${props.paceMark * 100}% - 1px)` }} /> : null}
    </span>
  )
}
