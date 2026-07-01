import { test, expect, describe } from "bun:test";
import { createCoalescer } from "../src/throttle";

describe("throttle: redraw coalescer", () => {
  test("many schedules inside a frame collapse to a single flush", () => {
    let flushes = 0;
    let fire: (() => void) | null = null;
    const c = createCoalescer({
      onFlush: () => flushes++,
      setTimer: (fn) => { fire = fn; return 1; },
      clearTimer: () => { fire = null; },
    });

    c.schedule();
    c.schedule();
    c.schedule();
    expect(flushes).toBe(0); // nothing until the frame fires
    fire!(); // frame boundary
    expect(flushes).toBe(1); // three schedules → one repaint

    // A schedule after the frame starts a new window.
    c.schedule();
    expect(flushes).toBe(1);
    fire!();
    expect(flushes).toBe(2);
  });

  test("flushNow drains immediately; cancel drops the pending flush", () => {
    let flushes = 0;
    const c = createCoalescer({ onFlush: () => flushes++, setTimer: () => 1, clearTimer: () => {} });
    c.schedule();
    c.flushNow();
    expect(flushes).toBe(1);

    c.schedule();
    c.cancel();
    c.flushNow();
    expect(flushes).toBe(1); // cancel cleared the pending work
  });
});
