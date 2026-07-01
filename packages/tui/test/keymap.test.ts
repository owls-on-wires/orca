import { test, expect, describe } from "bun:test";
import { resolveKey, type KeyState, type ResolveCtx } from "../src/keymap";

const ctx = (over: Partial<ResolveCtx> = {}): ResolveCtx => ({
  focus: "circuit",
  editing: false,
  executorRunning: true,
  ...over,
});

const noKey: KeyState = {};

describe("keymap", () => {
  test("globals fire regardless of focus/editing", () => {
    expect(resolveKey("", { f2: true }, ctx()).type).toBe("pause");
    expect(resolveKey("", { f2: true }, ctx({ executorRunning: false })).type).toBe("resume");
    expect(resolveKey("", { f9: true }, ctx()).type).toBe("abort");
    expect(resolveKey("l", { ctrl: true }, ctx()).type).toBe("focus-mode");
    expect(resolveKey("", { tab: true }, ctx()).type).toBe("cycle-focus");
    // even while editing text
    expect(resolveKey("", { f2: true }, ctx({ editing: true })).type).toBe("pause");
  });

  test("q detaches only when not editing", () => {
    expect(resolveKey("q", noKey, ctx({ focus: "circuit" })).type).toBe("detach");
    expect(resolveKey("q", noKey, ctx({ editing: true })).type).toBe("none");
  });

  test("circuit-pane navigation + steer", () => {
    expect(resolveKey("", { upArrow: true }, ctx()).type).toBe("select-prev");
    expect(resolveKey("", { downArrow: true }, ctx()).type).toBe("select-next");
    expect(resolveKey("", { return: true }, ctx()).type).toBe("open-detail");
    expect(resolveKey("p", noKey, ctx())).toEqual({ type: "steer", action: "pause" });
    expect(resolveKey("x", noKey, ctx())).toEqual({ type: "steer", action: "abort" });
    expect(resolveKey("r", noKey, ctx())).toEqual({ type: "steer", action: "retry" });
  });

  test("steer keys do nothing in the conversation pane (they are typed text)", () => {
    expect(resolveKey("p", noKey, ctx({ focus: "conversation", editing: true }).valueOf() as ResolveCtx).type).toBe("none");
    expect(resolveKey("r", noKey, ctx({ focus: "conversation", editing: true })).type).toBe("none");
  });
});
