/** The port of `AsyncStream.makeStream`: values pushed in on one side arrive, in order, to one async iterator. */
export class AsyncStream<Value> implements AsyncIterable<Value> {
  private buffered: Value[] = []
  private waiting: ((result: IteratorResult<Value>) => void)[] = []
  private finished = false

  /** `continuation.yield(_:)` */
  yield(value: Value): void {
    if (this.finished) return
    const waiter = this.waiting.shift()
    if (waiter) waiter({ value, done: false })
    else this.buffered.push(value)
  }

  /** `continuation.finish()`. Values already yielded are still delivered. */
  finish(): void {
    if (this.finished) return
    this.finished = true
    for (const waiter of this.waiting.splice(0)) waiter({ value: undefined, done: true })
  }

  get isFinished(): boolean {
    return this.finished
  }

  [Symbol.asyncIterator](): AsyncIterator<Value> {
    return {
      next: (): Promise<IteratorResult<Value>> => {
        if (this.buffered.length > 0) return Promise.resolve({ value: this.buffered.shift() as Value, done: false })
        if (this.finished) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => this.waiting.push(resolve))
      }
    }
  }
}
