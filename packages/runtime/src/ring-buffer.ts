/**
 * Bounded, drop-on-overflow. Dropping is a first-class outcome, not an error:
 * the count is reported so the UI can say so rather than silently lying.
 */
export class RingBuffer<T> {
  private readonly slots: (T | undefined)[];
  private head = 0;
  private count = 0;
  private droppedCount = 0;

  private readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.slots = new Array<T | undefined>(capacity);
  }

  push(item: T): boolean {
    if (this.count === this.capacity) {
      this.droppedCount++;
      return false;
    }
    this.slots[(this.head + this.count) % this.capacity] = item;
    this.count++;
    return true;
  }

  drain(): T[] {
    const out: T[] = new Array<T>(this.count);
    for (let i = 0; i < this.count; i++) {
      out[i] = this.slots[(this.head + i) % this.capacity] as T;
      this.slots[(this.head + i) % this.capacity] = undefined;
    }
    this.head = 0;
    this.count = 0;
    return out;
  }

  /** Reads and clears the drop counter, so each report covers one interval. */
  takeDropped(): number {
    const dropped = this.droppedCount;
    this.droppedCount = 0;
    return dropped;
  }

  get length(): number {
    return this.count;
  }
}
