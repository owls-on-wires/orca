/**
 * Pure keybinding → command mapping. Resolving a keystroke to an intent is
 * separated from executing it so the whole interaction model is unit-testable
 * without Ink's input plumbing.
 *
 * Global keys (spec-tui): q detach · F2 pause · F9 abort · Ctrl+L focus-mode ·
 * Tab cycle focus. Circuit-pane keys: ↑/↓ select, Enter open detail, p/x/r steer
 * the selected node against the daemon.
 */

import type { Focus } from "./types";

export type Command =
  | { type: "detach" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "abort" }
  | { type: "focus-mode" }
  | { type: "cycle-focus" }
  | { type: "select-prev" }
  | { type: "select-next" }
  | { type: "open-detail" }
  | { type: "steer"; action: "pause" | "abort" | "retry" }
  | { type: "submit"; text: string }
  | { type: "none" };

/** Minimal shape of Ink's `useInput` key object we rely on. */
export interface KeyState {
  upArrow?: boolean;
  downArrow?: boolean;
  return?: boolean;
  tab?: boolean;
  ctrl?: boolean;
  escape?: boolean;
  f2?: boolean;
  f9?: boolean;
}

export interface ResolveCtx {
  focus: Focus;
  /** True while the input box is capturing text — most single-key steers are
   *  suppressed so the user can type freely; only globals fire. */
  editing: boolean;
  executorRunning: boolean;
}

export function resolveKey(input: string, key: KeyState, ctx: ResolveCtx): Command {
  // Globals fire regardless of focus/editing.
  if (key.f2) return ctx.executorRunning ? { type: "pause" } : { type: "resume" };
  if (key.f9) return { type: "abort" };
  if (key.ctrl && input === "l") return { type: "focus-mode" };
  if (key.tab) return { type: "cycle-focus" };

  // While typing in the input box, don't hijack ordinary keys.
  if (ctx.editing) return { type: "none" };

  // `q` detaches (only when not editing — otherwise it's just a character).
  if (input === "q") return { type: "detach" };

  if (ctx.focus === "circuit") {
    if (key.upArrow) return { type: "select-prev" };
    if (key.downArrow) return { type: "select-next" };
    if (key.return) return { type: "open-detail" };
    if (input === "p") return { type: "steer", action: "pause" };
    if (input === "x") return { type: "steer", action: "abort" };
    if (input === "r") return { type: "steer", action: "retry" };
  }

  return { type: "none" };
}
