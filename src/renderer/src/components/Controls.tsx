import { useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from 'react'
import { api } from '../bridge'
import type { MenuItemSpec } from '@shared/ipc'
import { useReduceAnimations } from '../state/context'
import { Icon } from './Icon'
import './components.css'

/** A row of choices on a capsule track, with a thumb that slides to the chosen one (upstream's `CapsuleSegments`). */
export function CapsuleSegments<Value extends string>(props: {
  options: readonly { value: Value; label: string }[]
  selection: Value
  onSelect: (value: Value) => void
  height?: number
  fontSize?: number
  /** A fixed width per segment; without it the segments share the track. */
  segmentWidth?: number
  /** Picks a segment as the mouse goes down and moves the thumb there at once, like a native tab. */
  selectsOnPress?: boolean
  style?: CSSProperties
}): ReactNode {
  const track = useRef<HTMLDivElement>(null)
  const [thumb, setThumb] = useState<{ left: number; width: number } | undefined>(undefined)
  const index = Math.max(0, props.options.findIndex((option) => option.value === props.selection))
  useLayoutEffect(() => {
    const node = track.current?.children[index + 1] as HTMLElement | undefined
    if (node) setThumb({ left: node.offsetLeft, width: node.offsetWidth })
  }, [index, props.options.length, props.segmentWidth])
  return (
    <div
      ref={track}
      className="capsule-segments"
      role="tablist"
      style={{ height: props.height ?? 28, fontSize: props.fontSize ?? 13, ...props.style }}
    >
      <div
        className="capsule-thumb"
        style={{
          left: thumb?.left ?? 2,
          width: thumb?.width ?? 0,
          opacity: thumb ? 1 : 0,
          transition: props.selectsOnPress ? 'none' : undefined
        }}
      />
      {props.options.map((option) => {
        const isSelected = option.value === props.selection
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={isSelected}
            className={`plain-button capsule-segment${isSelected ? ' is-selected' : ''}`}
            style={props.segmentWidth === undefined ? { flex: 1 } : { width: props.segmentWidth }}
            onPointerDown={() => {
              if (props.selectsOnPress && !isSelected) props.onSelect(option.value)
            }}
            onClick={() => {
              if (!isSelected) props.onSelect(option.value)
            }}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

/** A switch (SwiftUI's `Toggle` in the switch style). */
export function Toggle(props: { isOn: boolean; onChange: (isOn: boolean) => void; disabled?: boolean; label?: string; size?: 'small' | 'mini' }): ReactNode {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.isOn}
      aria-label={props.label}
      disabled={props.disabled}
      className={`plain-button toggle${props.isOn ? ' is-on' : ''}${props.size === 'mini' ? ' is-mini' : ''}`}
      onClick={() => props.onChange(!props.isOn)}
    >
      <span className="toggle-knob" />
    </button>
  )
}

type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'style'> & {
  /** `prominent` is the accent-filled default action; `bordered` the grey one; `destructive` a red-text bordered one. */
  variant?: 'prominent' | 'bordered' | 'destructive'
  /** SwiftUI's controlSize. */
  size?: 'large' | 'regular' | 'small'
  fullWidth?: boolean
  style?: CSSProperties
}

/** A push button (SwiftUI's `.bordered` and `.borderedProminent` styles). */
export function Button({ variant = 'bordered', size = 'regular', fullWidth, className, children, ...rest }: ButtonProps): ReactNode {
  return (
    <button
      type="button"
      {...rest}
      className={`push-button is-${variant} is-${size}${fullWidth ? ' is-full' : ''}${className ? ` ${className}` : ''}`}
    >
      {children}
    </button>
  )
}

/** A round icon button on the control fill, like the footer's Options button. */
export function RoundIconButton(props: {
  icon: string
  label: string
  iconSize?: number
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void
  disabled?: boolean
}): ReactNode {
  return (
    <button type="button" className="plain-button round-icon-button" aria-label={props.label} disabled={props.disabled} onClick={props.onClick}>
      <Icon name={props.icon} size={props.iconSize ?? 13} weight="semibold" />
    </button>
  )
}

/** The small indeterminate spinner (`MotionAwareProgressView`). With Reduce Motion it is a still refresh glyph. */
export function Spinner(props: { size?: number }): ReactNode {
  const reduce = useReduceAnimations()
  const size = props.size ?? 12
  if (reduce) return <Icon name="arrow.triangle.2.circlepath" size={10} weight="medium" className="secondary" />
  return (
    <span className="spinner" role="progressbar" aria-label="Loading" style={{ width: size, height: size }}>
      {Array.from({ length: 8 }, (_, index) => (
        <span key={index} style={{ transform: `rotate(${index * 45}deg)`, animationDelay: `${-0.8 + index * 0.1}s` }} />
      ))}
    </span>
  )
}

/** A text field in the panel's style. */
export function TextField(props: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  secure?: boolean
  autoFocus?: boolean
  disabled?: boolean
  monospaced?: boolean
  onSubmit?: () => void
  onCancel?: () => void
  label?: string
  style?: CSSProperties
}): ReactNode {
  return (
    <input
      className="text-field"
      type={props.secure ? 'password' : 'text'}
      value={props.value}
      placeholder={props.placeholder}
      aria-label={props.label ?? props.placeholder}
      autoFocus={props.autoFocus}
      disabled={props.disabled}
      spellCheck={false}
      autoComplete="off"
      style={{ fontFamily: props.monospaced ? 'ui-monospace, Consolas, monospace' : undefined, ...props.style }}
      onChange={(event) => props.onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && props.onSubmit) {
          event.preventDefault()
          props.onSubmit()
        } else if (event.key === 'Escape' && props.onCancel) {
          event.preventDefault()
          event.stopPropagation()
          props.onCancel()
        }
      }}
    />
  )
}

/** A pop-up picker (SwiftUI's `Picker` in the menu style), drawn with the platform's own list. */
export function Picker<Value extends string | number>(props: {
  value: Value
  options: readonly { value: Value; label: string }[]
  onChange: (value: Value) => void
  disabled?: boolean
  label?: string
}): ReactNode {
  return (
    <span className="picker">
      <select
        value={String(props.value)}
        aria-label={props.label}
        disabled={props.disabled}
        onChange={(event) => {
          const chosen = props.options.find((option) => String(option.value) === event.target.value)
          if (chosen) props.onChange(chosen.value)
        }}
      >
        {props.options.map((option) => (
          <option key={String(option.value)} value={String(option.value)}>
            {option.label}
          </option>
        ))}
      </select>
      <Icon name="chevron.down" size={9} weight="bold" className="picker-chevron" />
    </span>
  )
}

/**
 * Shows a native menu at the pointer and answers the id of the item chosen, or undefined. Use it for
 * every right-click menu and pull-down, as upstream uses `NSMenu`.
 */
export function showMenu(items: MenuItemSpec[]): Promise<string | undefined> {
  return api.showMenu(items)
}

/** A capsule notice that pops in briefly, such as "Copied to clipboard" (`TransientPill`). */
export function TransientPill(props: { icon: string; text: string; tint?: string }): ReactNode {
  return (
    <div className="transient-pill" style={{ color: props.tint ?? 'var(--blue)' }}>
      <Icon name={props.icon} size={11} weight="semibold" />
      <span>{props.text}</span>
    </div>
  )
}
