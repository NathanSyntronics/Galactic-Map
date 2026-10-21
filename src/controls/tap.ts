/**
 * Tells taps (a single pointer pressed and released quickly without moving) apart from drags and
 * multi-touch gestures. Once a second pointer goes down, the whole gesture is a multi-touch
 * gesture: none of its pointers counts as a tap, not even the last one lifted, until all pointers
 * are up and a new gesture starts.
 */
export class TapDetector {
  private readonly pointers = new Map<number, { x: number; y: number; time: number }>();
  private multi = false;

  constructor(
    private readonly maxMovePx = 6,
    private readonly maxDurationMs = 600,
  ) {}

  /** `primary`: PointerEvent.isPrimary, true for the first pointer of a new gesture. */
  down(id: number, x: number, y: number, time: number, primary = true): void {
    // A primary pointer starts a new gesture: forget pointers whose "up" was never seen.
    if (primary && !this.pointers.has(id)) {
      this.pointers.clear();
      this.multi = false;
    }
    if (this.pointers.size > 0 && !this.pointers.has(id)) this.multi = true;
    this.pointers.set(id, { x, y, time });
  }

  /** Returns true if this pointer-up completes a tap. */
  up(id: number, x: number, y: number, time: number): boolean {
    const p = this.pointers.get(id);
    if (!p) return false;
    this.pointers.delete(id);
    const multi = this.multi;
    if (this.pointers.size === 0) this.multi = false;
    if (multi) return false;
    return Math.hypot(x - p.x, y - p.y) <= this.maxMovePx && time - p.time <= this.maxDurationMs;
  }

  /** pointercancel: the pointer's gesture is aborted and is never a tap. */
  cancel(id: number): void {
    if (!this.pointers.delete(id)) return;
    if (this.pointers.size === 0) this.multi = false;
  }

  get activePointers(): number {
    return this.pointers.size;
  }
}
