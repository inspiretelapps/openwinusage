import type { CSSProperties, ReactNode } from 'react'
import { Provider } from '@core/models/Provider'
import { useStores } from '../../state/context'

/** Upstream blurs a concealed name with a radius of 4 points. */
const concealedStyle: CSSProperties = { filter: 'blur(4px)' }

/**
 * Whether this account's name is blurred right now: Privacy Mode sees a capture, and the account has a
 * name of its own. The provider's name, shown for an account without one, stays readable.
 */
export function useConcealsAccountName(provider: Provider): boolean {
  const isConcealing = useStores().state.privacyMode.isConcealing
  return isConcealing && Provider.labelBesideName(provider) !== undefined
}

/**
 * The style that blurs an account's name in place, or undefined when it stays readable (upstream's
 * `concealingAccountName(of:)`). `conceals` is the `concealsAccountNames` environment value: pass it
 * for a view drawn outside the panel's own state, such as a copied card.
 */
export function accountNameConcealment(provider: Provider, conceals: boolean): CSSProperties | undefined {
  return conceals && Provider.labelBesideName(provider) !== undefined ? concealedStyle : undefined
}

/**
 * An account's name, blurred in place while names are concealed. Wrap exactly the text that is the
 * account's own name: `<ConcealedName provider={provider}>{label}</ConcealedName>`.
 */
export function ConcealedName(props: {
  provider: Provider
  children: ReactNode
  /** Overrides the panel's own state: true on a copied card while Privacy Mode is on. */
  conceals?: boolean
  className?: string
  style?: CSSProperties
}): ReactNode {
  const fromPanel = useStores().state.privacyMode.isConcealing
  const concealment = accountNameConcealment(props.provider, props.conceals ?? fromPanel)
  return (
    <span className={props.className} style={{ ...props.style, ...concealment }}>
      {props.children}
    </span>
  )
}
