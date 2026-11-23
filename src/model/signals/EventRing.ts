import type { HemoEventKind } from '../contracts/types';

/**
 * Allocation-free circular event buffer (kind, t).
 * Consumers keep the last `seq` read and iterate with `forEachSince`.
 */
export class EventRing {
  readonly capacity: number;
  private kinds: Int16Array;
  private times: Float64Array;
  /** total number of events already pushed (monotonic) */
  seq = 0;

  constructor(capacity = 256) {
    this.capacity = capacity;
    this.kinds = new Int16Array(capacity);
    this.times = new Float64Array(capacity);
  }

  push(kind: HemoEventKind, t: number): void {
    const i = this.seq % this.capacity;
    this.kinds[i] = kind;
    this.times[i] = t;
    this.seq++;
  }

  /** Iterates events with seq ∈ [fromSeq, seq). Returns the new cursor. */
  forEachSince(fromSeq: number, cb: (kind: HemoEventKind, t: number) => void): number {
    const start = Math.max(fromSeq, this.seq - this.capacity);
    for (let s = start; s < this.seq; s++) {
      const i = s % this.capacity;
      cb(this.kinds[i] as HemoEventKind, this.times[i]);
    }
    return this.seq;
  }

  /** Time of the last event of type `kind` (or -Infinity). */
  lastTime(kind: HemoEventKind): number {
    const n = Math.min(this.seq, this.capacity);
    for (let k = 1; k <= n; k++) {
      const i = (this.seq - k) % this.capacity;
      if (this.kinds[i] === kind) return this.times[i];
    }
    return -Infinity;
  }

  clear(): void {
    this.seq = 0;
  }
}
