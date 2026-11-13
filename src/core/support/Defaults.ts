/**
 * The app's preferences: the port of `UserDefaults`. Values are JSON (strings, numbers, booleans,
 * arrays, plain objects). The desktop app backs it with a JSON file in its data folder; tests and the
 * panel's read-only mirror use `MemoryDefaults`.
 */
export interface Defaults {
  /** `object(forKey:)`: undefined when the key is absent. */
  get(key: string): unknown
  /** `set(_:forKey:)`. Setting `undefined` removes the key. */
  set(key: string, value: unknown): void
  /** `removeObject(forKey:)` */
  remove(key: string): void
  keys(): string[]
}

export class MemoryDefaults implements Defaults {
  private values: Record<string, unknown>
  private listeners = new Set<(key: string) => void>()

  constructor(initial: Record<string, unknown> = {}) {
    this.values = { ...initial }
  }

  get(key: string): unknown {
    return this.values[key]
  }

  set(key: string, value: unknown): void {
    if (value === undefined) {
      this.remove(key)
      return
    }
    this.values[key] = value
    this.emit(key)
  }

  remove(key: string): void {
    if (!(key in this.values)) return
    delete this.values[key]
    this.emit(key)
  }

  keys(): string[] {
    return Object.keys(this.values)
  }

  /** Everything stored, for persistence and for mirroring into the panel. */
  snapshot(): Record<string, unknown> {
    return { ...this.values }
  }

  /** Replaces everything without notifying, for a mirror that follows another store. */
  replaceAll(values: Record<string, unknown>): void {
    this.values = { ...values }
  }

  onChange(listener: (key: string) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(key: string): void {
    for (const listener of [...this.listeners]) listener(key)
  }
}

let standard: Defaults = new MemoryDefaults()

/** `UserDefaults.standard`. The app installs its file-backed store at launch; until then it is in memory. */
export function standardDefaults(): Defaults {
  return standard
}

export function setStandardDefaults(defaults: Defaults): void {
  standard = defaults
}

// Typed reads, mirroring the `UserDefaults` accessors the Swift code uses.

/** `string(forKey:)` */
export function defaultsString(defaults: Defaults, key: string): string | undefined {
  const value = defaults.get(key)
  return typeof value === 'string' ? value : undefined
}

/** `bool(forKey:default:)`: the fallback when the key is absent or not a boolean. */
export function defaultsBool(defaults: Defaults, key: string, fallback = false): boolean {
  const value = defaults.get(key)
  return typeof value === 'boolean' ? value : fallback
}

/** A stored number, or undefined. `integer(forKey:)` / `double(forKey:)` return 0 for a missing key; pass a fallback for that. */
export function defaultsNumber(defaults: Defaults, key: string): number | undefined {
  const value = defaults.get(key)
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** `enumValue(forKey:default:)`: the stored raw value when it is one of `allowed`, else the fallback. */
export function defaultsEnum<T extends string>(defaults: Defaults, key: string, allowed: readonly T[], fallback: T): T {
  const value = defaults.get(key)
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback
}

/** `stringArray(forKey:)` */
export function defaultsStringArray(defaults: Defaults, key: string): string[] | undefined {
  const value = defaults.get(key)
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? (value as string[]) : undefined
}

/** A stored JSON object (what Swift keeps as encoded `Data`), or undefined. */
export function defaultsObject<T>(defaults: Defaults, key: string): T | undefined {
  const value = defaults.get(key)
  return value !== null && typeof value === 'object' ? (value as T) : undefined
}
