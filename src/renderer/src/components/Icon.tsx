import {
  AlarmClockOff,
  AppWindow,
  ArrowUpRight,
  Bell,
  Bug,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleArrowDown,
  CircleCheck,
  CircleHelp,
  CircleUser,
  CircleX,
  Clock,
  ClockAlert,
  Copy,
  Ellipsis,
  Eye,
  EyeOff,
  Flame,
  GripVertical,
  Hourglass,
  Info,
  KeyRound,
  Link,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Power,
  RefreshCw,
  Server,
  Settings,
  SquareTerminal,
  Trash2,
  TriangleAlert,
  X,
  type LucideIcon
} from 'lucide-react'
import type { CSSProperties, ReactNode } from 'react'

/**
 * Upstream draws its icons with SF Symbols. Each symbol name used there maps to the closest Lucide
 * icon here, so a view port keeps the upstream name: `<Icon name="gearshape" size={13} weight="semibold" />`.
 * Add a line when a view needs a symbol that is not listed yet.
 */
const symbols: Record<string, LucideIcon> = {
  'chevron.backward': ChevronLeft,
  'chevron.left': ChevronLeft,
  'chevron.right': ChevronRight,
  'chevron.forward': ChevronRight,
  'chevron.down': ChevronDown,
  gearshape: Settings,
  macwindow: AppWindow,
  bell: Bell,
  terminal: SquareTerminal,
  ellipsis: Ellipsis,
  'doc.on.doc': Copy,
  checkmark: Check,
  'checkmark.circle.fill': CircleCheck,
  'checkmark.circle': CircleCheck,
  'person.crop.circle': CircleUser,
  'arrow.triangle.2.circlepath': RefreshCw,
  'arrow.clockwise': RefreshCw,
  ladybug: Bug,
  'info.circle': Info,
  'questionmark.circle': CircleHelp,
  power: Power,
  plus: Plus,
  xmark: X,
  'arrow.down.circle': CircleArrowDown,
  'exclamationmark.triangle.fill': TriangleAlert,
  'exclamationmark.triangle': TriangleAlert,
  'exclamationmark.circle': CircleAlert,
  'exclamationmark.circle.fill': CircleAlert,
  clock: Clock,
  'clock.fill': Clock,
  'clock.badge.xmark': AlarmClockOff,
  'clock.badge.questionmark': ClockAlert,
  'info.circle.fill': Info,
  'xmark.circle.fill': CircleX,
  'xmark.circle': CircleX,
  pin: Pin,
  'pin.fill': Pin,
  'pin.slash': PinOff,
  'line.3.horizontal': GripVertical,
  eye: Eye,
  'eye.slash': EyeOff,
  trash: Trash2,
  pencil: Pencil,
  key: KeyRound,
  link: Link,
  'arrow.up.right': ArrowUpRight,
  'server.rack': Server,
  'flame.fill': Flame,
  'hourglass.tophalf.filled': Hourglass
}

export type IconWeight = 'regular' | 'medium' | 'semibold' | 'bold'

const strokes: Record<IconWeight, number> = { regular: 1.75, medium: 2, semibold: 2.3, bold: 2.6 }

export function Icon(props: {
  /** The SF Symbol name upstream uses. */
  name: string
  /** The symbol's font size upstream, in points. */
  size?: number
  weight?: IconWeight
  /** Fills the shape: for the `.fill` symbols that should read solid. */
  filled?: boolean
  className?: string
  style?: CSSProperties
}): ReactNode {
  const Glyph = symbols[props.name] ?? CircleHelp
  const size = props.size ?? 13
  // An SF Symbol's glyph is a little larger than its point size; Lucide draws inside a 24-unit box with padding.
  const side = Math.round(size * 1.2)
  return (
    <Glyph
      aria-hidden
      width={side}
      height={side}
      strokeWidth={strokes[props.weight ?? 'regular']}
      fill={props.filled ? 'currentColor' : 'none'}
      className={props.className}
      style={{ flex: 'none', ...props.style }}
    />
  )
}
