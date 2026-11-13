import type { CSSProperties, ReactNode } from 'react'
import './Form.css'

/**
 * A grouped form (SwiftUI's `Form` in the `.grouped` style): sections stacked with the system's gap.
 * It adds no margin of its own; the screen or sheet around it sets the cards in.
 */
export function Form(props: { children: ReactNode; disabled?: boolean; style?: CSSProperties }): ReactNode {
  return (
    <div className="form" aria-disabled={props.disabled || undefined} style={props.style}>
      {props.children}
    </div>
  )
}

/**
 * One group of a form, like a group in System Settings: `children` are its rows on a card, separated
 * by hairlines, under an optional `header` and over an optional `footer`. A footer that renders
 * nothing (null, undefined, false) takes no room.
 */
export function FormSection(props: { header?: ReactNode; footer?: ReactNode; children: ReactNode; style?: CSSProperties }): ReactNode {
  const has = (node: ReactNode): boolean => node !== undefined && node !== null && node !== false
  return (
    <section className="form-section" style={props.style}>
      {has(props.header) ? <div className="form-section-header">{props.header}</div> : null}
      <div className="card form-section-rows">{props.children}</div>
      {has(props.footer) ? <div className="form-section-footer">{props.footer}</div> : null}
    </section>
  )
}

/**
 * A row of a section: its `label` at the leading edge and its control (`children`) at the trailing
 * edge (SwiftUI's `LabeledContent`, and what a `Toggle` or `Picker` with a title draws in a form).
 * Without a label the children take the whole row.
 */
export function FormRow(props: { label?: ReactNode; children?: ReactNode; style?: CSSProperties }): ReactNode {
  return (
    <div className="form-row" style={props.style}>
      {props.label !== undefined ? <div className="form-row-label">{props.label}</div> : null}
      {props.children !== undefined ? <div className={`form-row-content${props.label === undefined ? ' is-alone' : ''}`}>{props.children}</div> : null}
    </div>
  )
}

/**
 * A text field as a form row: the label at the leading edge and borderless text typed at the trailing
 * edge, with `prompt` shown while it is empty (a `TextField` or `SecureField` inside a grouped `Form`).
 */
export function FormTextField(props: {
  label: string
  value: string
  onChange: (value: string) => void
  prompt?: string
  secure?: boolean
  autoFocus?: boolean
  disabled?: boolean
  onSubmit?: () => void
}): ReactNode {
  return (
    <label className="form-row">
      <span className="form-row-label">{props.label}</span>
      <input
        className="form-text-field"
        type={props.secure ? 'password' : 'text'}
        value={props.value}
        placeholder={props.prompt}
        aria-label={props.label}
        autoFocus={props.autoFocus}
        disabled={props.disabled}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => props.onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || !props.onSubmit) return
          event.preventDefault()
          props.onSubmit()
        }}
      />
    </label>
  )
}
