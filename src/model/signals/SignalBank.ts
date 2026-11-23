import type { SignalBankLike } from '../contracts/types';

/**
 * Time-series bank in aligned circular buffers.
 * All channels share `head` (index of the next write) — sample i
 * of any channel corresponds to the same instant.
 *
 * Usage (by the SimulationLoop): systems call `set(name, value)` in `sample()`,
 * then the loop calls `commit()` once.
 * Reading (Canvas 2D): `read(name)` + `head`/`count`, or `latest(name, k)`.
 */
export class SignalBank implements SignalBankLike {
  readonly capacity: number;
  readonly sampleRate: number;
  private channels = new Map<string, Float32Array>();
  /** index of the next write */
  head = 0;
  /** valid samples (≤ capacity) */
  count = 0;
  /** total commits (monotonic) — useful for incremental drawing */
  total = 0;

  constructor(capacity = 5000, sampleRate = 500) {
    this.capacity = capacity;
    this.sampleRate = sampleRate;
  }

  register(name: string): Float32Array {
    let ch = this.channels.get(name);
    if (!ch) {
      ch = new Float32Array(this.capacity);
      this.channels.set(name, ch);
    }
    return ch;
  }

  has(name: string): boolean {
    return this.channels.has(name);
  }

  set(name: string, value: number): void {
    const ch = this.channels.get(name) ?? this.register(name);
    ch[this.head] = value;
  }

  commit(): void {
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
    this.total++;
  }

  /** Raw channel buffer (circular). */
  read(name: string): Float32Array | undefined {
    return this.channels.get(name);
  }

  /** Value k samples back (k = 0 → the most recent). */
  latest(name: string, k = 0): number {
    const ch = this.channels.get(name);
    if (!ch || this.count === 0) return 0;
    const i = (this.head - 1 - k + this.capacity * 2) % this.capacity;
    return ch[i];
  }

  /** Circular index of the sample k back from the most recent. */
  indexAgo(k: number): number {
    return (this.head - 1 - k + this.capacity * 2) % this.capacity;
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
    this.total = 0;
    for (const ch of this.channels.values()) ch.fill(0);
  }
}
