/**
 * The port of an `@Observable` store: anything that holds state the UI follows extends this and calls
 * `notify()` after it changes. Listeners get no payload; they read the store.
 */
export class Observable {
  private listeners = new Set<() => void>()

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  protected notify(): void {
    for (const listener of [...this.listeners]) listener()
  }
}
