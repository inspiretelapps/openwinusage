import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { api } from '../../bridge'
import { Icon } from '../../components/Icon'
import { useAppState } from '../../state/context'

const punctuation: Record<string, string> = {
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`'
}

const named: Record<string, string> = {
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Space: 'Space',
  Enter: 'Return',
  NumpadEnter: 'Return',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  NumpadAdd: 'numadd',
  NumpadSubtract: 'numsub',
  NumpadMultiply: 'nummult',
  NumpadDivide: 'numdiv',
  NumpadDecimal: 'numdec'
}

/**
 * The Electron accelerator key for a physical key (`KeyboardEvent.code`), or undefined for a key that
 * cannot end a shortcut: a modifier, or one Electron has no name for.
 */
export function acceleratorKey(code: string): string | undefined {
  const letter = /^Key([A-Z])$/.exec(code)
  if (letter) return letter[1]
  const digit = /^Digit([0-9])$/.exec(code)
  if (digit) return digit[1]
  const numpad = /^Numpad([0-9])$/.exec(code)
  if (numpad) return `num${numpad[1]}`
  const fn = /^F([0-9]{1,2})$/.exec(code)
  if (fn && Number(fn[1]) >= 1 && Number(fn[1]) <= 24) return code
  return named[code] ?? punctuation[code]
}

/** The accelerator for a key press: at least one modifier and one other key, else undefined. */
export function acceleratorFor(event: { code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }): string | undefined {
  const key = acceleratorKey(event.code)
  if (key === undefined) return undefined
  const parts: string[] = []
  if (event.ctrlKey) parts.push('Control')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  if (event.metaKey) parts.push('Super')
  if (parts.length === 0) return undefined
  return [...parts, key].join('+')
}

const modifierNames: Record<string, string> = {
  control: 'Ctrl',
  ctrl: 'Ctrl',
  commandorcontrol: 'Ctrl',
  cmdorctrl: 'Ctrl',
  alt: 'Alt',
  option: 'Alt',
  altgr: 'AltGr',
  shift: 'Shift',
  super: 'Win',
  meta: 'Win',
  command: 'Win',
  cmd: 'Win'
}

const keyNames: Record<string, string> = {
  plus: '+',
  return: 'Enter',
  enter: 'Enter',
  pageup: 'Page Up',
  pagedown: 'Page Down',
  numadd: 'Num +',
  numsub: 'Num -',
  nummult: 'Num *',
  numdiv: 'Num /',
  numdec: 'Num .'
}

/** `Control+Alt+U` as it reads on a Windows keyboard: `Ctrl + Alt + U`. */
export function shortcutLabel(accelerator: string): string {
  // A trailing "+" is the plus key itself, which Electron also spells "Plus".
  const parts = accelerator.endsWith('++') ? [...accelerator.slice(0, -2).split('+'), 'Plus'] : accelerator.split('+')
  return parts
    .filter((part) => part !== '')
    .map((part) => {
      const lower = part.toLowerCase()
      const numpad = /^num([0-9])$/.exec(lower)
      if (numpad) return `Num ${numpad[1]}`
      return modifierNames[lower] ?? keyNames[lower] ?? (part.length === 1 ? part.toUpperCase() : part)
    })
    .join(' + ')
}

function heldModifiers(event: KeyboardEvent<HTMLElement>): string {
  const parts: string[] = []
  if (event.ctrlKey) parts.push('Ctrl')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  if (event.metaKey) parts.push('Win')
  return parts.join(' + ')
}

/**
 * The Global Shortcut field (upstream's `KeyboardShortcuts.Recorder`). Click it, then press the keys:
 * a modifier plus one other key. Esc cancels; Backspace, Delete, or the ✕ clears the shortcut.
 *
 * While it records, the field carries `data-recording="true"` so the shell leaves its keys alone, and
 * the app switches the current shortcut off so its own keys can be pressed.
 */
export function ShortcutRecorder(props: { disabled?: boolean }): ReactNode {
  const { accelerator } = useAppState().shortcut
  const [isRecording, setIsRecording] = useState(false)
  const [held, setHeld] = useState('')
  const recording = useRef(false)
  const field = useRef<HTMLDivElement>(null)

  const start = useCallback(() => {
    if (recording.current) return
    recording.current = true
    setIsRecording(true)
    setHeld('')
    void api.setShortcutRecording(true)
  }, [])

  /** Ends recording. `change` saves a new shortcut (or clears it with `accelerator: undefined`) before the app switches shortcuts back on. */
  const finish = useCallback((change?: { accelerator: string | undefined }) => {
    if (!recording.current) {
      if (change) void api.setShortcut(change.accelerator).catch(() => undefined)
      return
    }
    recording.current = false
    setIsRecording(false)
    setHeld('')
    void (async () => {
      // A refused shortcut comes back as `state.shortcut.errorMessage`, shown under the field.
      if (change) await api.setShortcut(change.accelerator).catch(() => undefined)
      await api.setShortcutRecording(false).catch(() => undefined)
    })()
  }, [])

  // Leaving Settings, or the panel closing, must never leave the app's shortcut switched off.
  useEffect(
    () => () => {
      if (recording.current) {
        recording.current = false
        void api.setShortcutRecording(false).catch(() => undefined)
      }
    },
    []
  )
  useEffect(() => {
    if (props.disabled && recording.current) finish()
  }, [props.disabled, finish])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (props.disabled) return
    const plain = !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey
    if (!isRecording) {
      if (plain && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault()
        event.stopPropagation()
        start()
      }
      return
    }
    // Tab still moves on; the blur ends recording.
    if (plain && event.key === 'Tab') return
    event.preventDefault()
    event.stopPropagation()
    if (plain && event.key === 'Escape') {
      finish()
      field.current?.blur()
      return
    }
    if (plain && (event.key === 'Backspace' || event.key === 'Delete')) {
      finish({ accelerator: undefined })
      field.current?.blur()
      return
    }
    const next = acceleratorFor(event.nativeEvent)
    if (next === undefined) {
      setHeld(heldModifiers(event))
      return
    }
    finish({ accelerator: next })
    field.current?.blur()
  }

  const text = isRecording ? (held !== '' ? `${held} + …` : 'Press Shortcut') : accelerator !== undefined ? shortcutLabel(accelerator) : 'Record Shortcut'
  const showsClear = !isRecording && accelerator !== undefined && !props.disabled
  return (
    <div
      ref={field}
      role="button"
      tabIndex={props.disabled ? -1 : 0}
      aria-label="Global Shortcut"
      aria-disabled={props.disabled}
      data-recording={isRecording ? 'true' : undefined}
      className={`shortcut-recorder${isRecording ? ' is-recording' : ''}${accelerator === undefined && !isRecording ? ' is-empty' : ''}${props.disabled ? ' is-disabled' : ''}`}
      onClick={() => {
        if (props.disabled) return
        if (isRecording) finish()
        else start()
      }}
      onKeyDown={onKeyDown}
      onKeyUp={(event) => {
        if (isRecording) setHeld(heldModifiers(event))
      }}
      onBlur={() => finish()}
    >
      <span className="shortcut-recorder-text truncate">{text}</span>
      {showsClear ? (
        <button
          type="button"
          className="plain-button shortcut-recorder-clear"
          aria-label="Clear Shortcut"
          tabIndex={-1}
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => {
            event.stopPropagation()
            finish({ accelerator: undefined })
          }}
        >
          <Icon name="xmark" size={7} weight="bold" />
        </button>
      ) : null}
    </div>
  )
}
