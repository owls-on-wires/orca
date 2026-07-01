/**
 * Redraw coalescer. SSE can burst faster than a terminal should repaint; this
 * caps repaints to ~15fps by collapsing every event received inside a frame
 * window into a single flush. Pure and timer-injectable so it unit-tests without
 * real wall-clock waits.
 */

export interface Coalescer {
  /** Signal that state changed and a redraw is wanted. */
  schedule(): void;
  /** Cancel any pending flush (on teardown). */
  cancel(): void;
  /** For tests: force the pending flush now. */
  flushNow(): void;
}

export interface CoalescerDeps {
  onFlush: () => void;
  /** ~66ms ≈ 15fps. */
  frameMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export function createCoalescer(deps: CoalescerDeps): Coalescer {
  const frameMs = deps.frameMs ?? 66;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let handle: unknown = null;
  let pending = false;

  const flush = () => {
    handle = null;
    if (!pending) return;
    pending = false;
    deps.onFlush();
  };

  return {
    schedule() {
      pending = true;
      if (handle !== null) return; // already within a frame window
      handle = setTimer(flush, frameMs);
    },
    cancel() {
      if (handle !== null) { clearTimer(handle); handle = null; }
      pending = false;
    },
    flushNow() {
      if (handle !== null) { clearTimer(handle); handle = null; }
      flush();
    },
  };
}
