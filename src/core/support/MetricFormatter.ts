import { ProviderParse } from './ProviderParse'
import { rounded } from './numbers'
import type { MetricKind } from '../models/MetricKind'
import type { MetricValue } from '../models/MetricValue'

export type MetricFormatterStyle = 'tray' | 'row'

const locale = 'en-US'
// Foundation's format styles round ties to even; `Intl` rounds them away from zero unless told otherwise.
const roundingMode = 'halfEven'

type NumberFormatOptions = Intl.NumberFormatOptions & { roundingMode?: string }

const formatters = new Map<string, Intl.NumberFormat>()

function formatter(options: NumberFormatOptions): Intl.NumberFormat {
  const key = JSON.stringify(options)
  let cached = formatters.get(key)
  if (!cached) {
    cached = new Intl.NumberFormat(locale, { ...options, roundingMode } as Intl.NumberFormatOptions)
    formatters.set(key, cached)
  }
  return cached
}

function compact(value: number): string {
  return formatter({ notation: 'compact', minimumFractionDigits: 0, maximumFractionDigits: 1 }).format(value)
}

function currencySymbol(code: string): string {
  try {
    const parts = formatter({ style: 'currency', currency: code }).formatToParts(0)
    return parts.find((part) => part.type === 'currency')?.value ?? code
  } catch {
    return code
  }
}

function currency(value: number, code: string, fractionDigits: number): string {
  try {
    return formatter({
      style: 'currency',
      currency: code,
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits
    }).format(value)
  } catch {
    // An unknown currency code: the code itself stands in for the symbol.
    return `${code} ${formatter({ minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits }).format(value)}`
  }
}

export const MetricFormatter = {
  number(value: number, kind: MetricKind, style: MetricFormatterStyle, currencyCode?: string): string {
    switch (kind) {
      case 'percent':
        return `${rounded(ProviderParse.clampPercent(value))}%`
      case 'dollars': {
        const code = currencyCode ?? 'USD'
        const symbol = currencySymbol(code)
        if (Math.abs(value) >= 1000) return symbol + compact(value)
        if (style === 'tray') {
          const digits = value !== 0 && Math.abs(value) < 1 ? 2 : 0
          return symbol + formatter({ minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value)
        }
        const whole = rounded(value * 100) % 100 === 0
        return currency(value, code, whole ? 0 : 2)
      }
      case 'count':
        if (Math.abs(value) >= 1000) return compact(value)
        return formatter({ minimumFractionDigits: 0, maximumFractionDigits: 1 }).format(value)
    }
  },

  string(value: MetricValue, style: MetricFormatterStyle): string {
    const text = MetricFormatter.number(value.number, value.kind, style, value.currencyCode)
    if (value.label === undefined || value.label.length === 0) return text
    return `${text} ${value.label}`
  }
}
