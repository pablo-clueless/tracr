/**
 * Bounded queue for frames produced while a transport is reconnecting.
 * Drop-on-overflow matches the ring buffer's philosophy: losing data is a
 * first-class outcome, and the loss flows into the next batch's drop count so
 * the daemon sees one truthful "events lost" number.
 */
export class PendingQueue<T> {
  private readonly items: T[] = [];
  private droppedCount = 0;
  private readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  push(item: T): void {
    if (this.items.length === this.capacity) {
      this.droppedCount++;
      return;
    }
    this.items.push(item);
  }

  drainInto(dropped: number): { items: T[]; dropped: number } {
    const out = this.items.splice(0);
    return { items: out, dropped: dropped + this.droppedCount };
  }

  get size(): number {
    return this.items.length;
  }
}
