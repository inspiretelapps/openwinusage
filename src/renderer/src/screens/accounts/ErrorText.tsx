import { useId, type CSSProperties, type ReactNode } from 'react'

/**
 * SF Symbols' `exclamationmark.triangle.fill`: a solid triangle with the mark cut out of it, in the
 * current text color. `size` is the symbol's point size upstream.
 */
export function NoticeTriangle(props: { size?: number; label?: string; style?: CSSProperties }): ReactNode {
  const id = useId()
  const side = Math.round((props.size ?? 13) * 1.2)
  return (
    <svg
      width={side}
      height={side}
      viewBox="0 0 24 24"
      role={props.label !== undefined ? 'img' : undefined}
      aria-label={props.label}
      aria-hidden={props.label === undefined ? true : undefined}
      style={{ flex: 'none', ...props.style }}
    >
      <mask id={id}>
        <rect width="24" height="24" fill="#fff" />
        <path d="M12 9v4.5" stroke="#000" strokeWidth="2.2" strokeLinecap="round" />
        <circle cx="12" cy="17" r="1.3" fill="#000" />
      </mask>
      <path
        mask={`url(#${id})`}
        fill="currentColor"
        d="M10.1 3.6a2.2 2.2 0 0 1 3.8 0l8.3 14.3A2.2 2.2 0 0 1 20.3 21H3.7a2.2 2.2 0 0 1-1.9-3.1z"
      />
    </svg>
  )
}

/** Why something failed, in red beside a warning triangle (upstream's `ErrorText`). */
export function ErrorText(props: { message: string; alignment?: 'leading' | 'center' }): ReactNode {
  const centered = props.alignment === 'center'
  return (
    <div className={`error-text${centered ? ' is-centered' : ''}`} role="alert">
      <NoticeTriangle size={12} style={{ marginTop: 1 }} />
      <span>{props.message}</span>
    </div>
  )
}
