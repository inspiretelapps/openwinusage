const mask = (1n << 64n) - 1n

/** SplitMix64, so one seed draws the same sample data on every run. */
export class DemoRandom {
  private state: bigint

  constructor(seed: number) {
    this.state = BigInt.asUintN(64, BigInt(Math.trunc(seed)))
  }

  next(): bigint {
    this.state = (this.state + 0x9e3779b97f4a7c15n) & mask
    let z = this.state
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & mask
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & mask
    return z ^ (z >> 31n)
  }

  /** A double in [0, 1), from the top 53 bits. */
  unit(): number {
    return Number(this.next() >> 11n) / 2 ** 53
  }

  /** `Int.random(in: lower..<upper)` */
  int(lower: number, upperExclusive: number): number {
    return lower + Math.floor(this.unit() * (upperExclusive - lower))
  }

  /** `Int.random(in: lower...upper)` */
  intThrough(lower: number, upper: number): number {
    return this.int(lower, upper + 1)
  }

  /** `Double.random(in: lower...upper)` */
  double(lower: number, upper: number): number {
    return lower + this.unit() * (upper - lower)
  }

  bool(): boolean {
    return (this.next() & 1n) === 1n
  }

  element<T>(items: readonly T[]): T {
    return items[this.int(0, items.length)]
  }

  /** `randomElement(using:)` on a collection that may be empty. */
  optionalElement<T>(items: readonly T[]): T | undefined {
    return items.length === 0 ? undefined : this.element(items)
  }

  shuffled<T>(items: readonly T[]): T[] {
    const out = [...items]
    for (let index = out.length - 1; index > 0; index--) {
      const other = this.int(0, index + 1)
      ;[out[index], out[other]] = [out[other], out[index]]
    }
    return out
  }
}
