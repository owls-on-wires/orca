import { test, expect, describe } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { App } from "../src/app";
import { initialState } from "../src/types";
import { applyEvent, addUserMessage, type SseEvent } from "../src/store";

const ev = (event: string, data: Record<string, unknown>): SseEvent => ({ event, data });

describe("App (presentational Ink render)", () => {
  test("renders the two-pane shell: top bar, braid, circuit, keybindings", () => {
    let s = initialState("saas-app", 0);
    s = addUserMessage(s, "build a SaaS app");
    s = applyEvent(s, ev("l3_message", { message_id: "m1", source: "l3", text: "Decomposed into 2 epics." }));
    s = applyEvent(s, ev("graph_edit", {
      ok: true,
      edits: [
        { op: "add_action", id: "epic.build", type: "agent", initial: true },
        { op: "add_action", id: "epic.test", type: "command" },
        { op: "add_edge", from: "epic.build", to: "epic.test", condition: "pass" },
      ],
      issues: [],
    }));
    s = applyEvent(s, ev("action_started", { action_id: "epic.build", type: "agent" }));
    s = applyEvent(s, ev("stats", { actions: { total: 2, running: 1 }, total_cost_usd: 0.11, executor: "running" }));

    const { lastFrame } = render(<App state={s} now={62_000} input="also add dark mode" />);
    const frame = lastFrame()!;

    // Top bar identity + telemetry.
    expect(frame).toContain("saas-app");
    expect(frame).toContain("running");
    expect(frame).toContain("$0.11");
    expect(frame).toContain("01:02"); // elapsed from now-startedAt
    // Braid narration + user input echo.
    expect(frame).toContain("build a SaaS app");
    expect(frame).toContain("Decomposed into 2 epics.");
    expect(frame).toContain("circuit edit");
    expect(frame).toContain("also add dark mode");
    // Circuit pane rows with glyphs.
    expect(frame).toContain("CIRCUIT");
    expect(frame).toContain("epic.build");
    expect(frame).toContain("◐"); // running glyph
    // Bottom bar keybindings.
    expect(frame).toContain("q detach");
  });

  test("no circuit pane before any work is reified (grows from a plain chat)", () => {
    let s = addUserMessage(initialState("orca", 0), "hello");
    const { lastFrame } = render(<App state={s} now={0} input="" />);
    expect(lastFrame()).not.toContain("CIRCUIT");
    expect(lastFrame()).toContain("CONVERSATION");
  });
});
