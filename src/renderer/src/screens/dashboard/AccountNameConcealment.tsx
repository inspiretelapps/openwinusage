import type { ReactNode } from 'react'
import { Provider } from '@core/models/Provider'

/**
 * Upstream's `concealingAccountName(of:)`: the class that blurs an account's own name while an
 * ancestor carries `data-conceals-names="true"` (the panel while Privacy Mode sees a capture, and a
 * copied card while it is on). The provider's name, shown for an account without one, stays readable.
 */
export function concealingAccountName(provider: Provider): string {
  return Provider.labelBesideName(provider) !== undefined ? 'account-name is-named' : 'account-name'
}

/**
 * One line of text that shortens with an ellipsis: at its end, or in its middle the way SwiftUI's
 * `.truncationMode(.middle)` keeps both ends of an email readable.
 */
export function TruncatedText(props: { text: string; mode?: 'tail' | 'middle'; className?: string; title?: string }): ReactNode {
  const { text } = props
  if (props.mode !== 'middle' || text.length < 8) {
    return (
      <span className={`db-truncate${props.className ? ` ${props.className}` : ''}`} aria-label={props.title}>
        {text}
      </span>
    )
  }
  const split = Math.ceil(text.length / 2)
  return (
    <span className={`db-truncate-middle${props.className ? ` ${props.className}` : ''}`} aria-label={props.title ?? text}>
      <span className="db-truncate-head" aria-hidden>
        {text.slice(0, split)}
      </span>
      <span className="db-truncate-tail" aria-hidden>
        <bdi>{text.slice(split)}</bdi>
      </span>
    </span>
  )
}
