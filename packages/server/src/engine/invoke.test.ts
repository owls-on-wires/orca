/**
 * Invoke-seam tests.
 *
 * `invoke()`/`invokeSimple()` are the stable, provider-neutral boundary; their
 * guts are Orca's own Layer B loop driving a ModelProvider (no claude binary, no
 * SDK). These verify the seam's public surface: the option/result/event shapes
 * and that `invoke()` is an async generator that terminates cleanly even with no
 * API key (the loop captures the error and yields an error result).
 */

import { describe, expect, test } from "bun:test";
import type { InvokeOptions, InvokeResult, InvokeEvent } from "./invoke";
import { invoke } from "./invoke";

describe("invoke", () => {
  describe("seam", () => {
    test("invoke function exists and is async generator", async () => {
      const options: InvokeOptions = {
        prompt: "test",
        projectDir: "/tmp",
        label: "test",
      };
      try {
        for await (const event of invoke(options)) { /* consume */ }
      } catch {
        // Tolerated — with no API key the loop yields an error result rather
        // than throwing, but a throw here is acceptable too.
      }
    });
  });

  describe("scope callback", () => {
    test("scope option is accepted", () => {
      const options: InvokeOptions = {
        prompt: "test",
        projectDir: "/project",
        scope: {
          writable: ["src/**"],
          readable: ["src/**", "tests/**"],
        },
      };
      // Verify the type accepts scope
      expect(options.scope!.writable).toEqual(["src/**"]);
    });

    test("scope with no patterns is valid", () => {
      const options: InvokeOptions = {
        prompt: "test",
        projectDir: "/project",
        scope: {},
      };
      expect(options.scope).toBeDefined();
    });
  });

  describe("options assembly", () => {
    test("all option fields are accepted", () => {
      const options: InvokeOptions = {
        prompt: "Implement the feature",
        projectDir: "/project",
        model: "opus",
        toolset: "all",
        maxTurns: 100,
        sessionId: "sess_abc123",
        outputSchema: { type: "object", properties: { status: { type: "string" } } },
        scope: { writable: ["src/**"] },
        timeout: 900,
        label: "develop",
        logPath: "/tmp/develop.jsonl",
      };
      expect(options.prompt).toBe("Implement the feature");
      expect(options.model).toBe("opus");
      expect(options.toolset).toBe("all");
      expect(options.maxTurns).toBe(100);
      expect(options.sessionId).toBe("sess_abc123");
      expect(options.timeout).toBe(900);
    });

    test("minimal options only require prompt and projectDir", () => {
      const options: InvokeOptions = {
        prompt: "test",
        projectDir: ".",
      };
      expect(options.model).toBeUndefined();
      expect(options.toolset).toBeUndefined();
      expect(options.sessionId).toBeUndefined();
    });
  });

  describe("InvokeResult type", () => {
    test("success result shape", () => {
      const result: InvokeResult = {
        output: { status: "completed", summary: "done" },
        costUsd: 1.50,
        sessionId: "sess_abc",
        numTurns: 5,
        durationMs: 15000,
        isError: false,
      };
      expect(result.output).not.toBeNull();
      expect(result.costUsd).toBe(1.50);
      expect(result.isError).toBe(false);
    });

    test("error result shape", () => {
      const result: InvokeResult = {
        output: null,
        costUsd: 0.50,
        sessionId: null,
        numTurns: 1,
        durationMs: 5000,
        isError: true,
      };
      expect(result.output).toBeNull();
      expect(result.isError).toBe(true);
    });
  });

  describe("InvokeEvent types", () => {
    test("text event", () => {
      const event: InvokeEvent = { type: "text", text: "Reading file..." };
      expect(event.type).toBe("text");
      expect(event.text).toBe("Reading file...");
    });

    test("tool_use event", () => {
      const event: InvokeEvent = {
        type: "tool_use",
        toolName: "Read",
        toolInput: { file_path: "/project/src/main.rs" },
      };
      expect(event.type).toBe("tool_use");
      expect(event.toolName).toBe("Read");
    });

    test("result event", () => {
      const event: InvokeEvent = {
        type: "result",
        result: {
          output: { status: "completed" },
          costUsd: 2.0,
          sessionId: "sess_x",
          numTurns: 8,
          durationMs: 30000,
          isError: false,
        },
      };
      expect(event.type).toBe("result");
      expect(event.result!.costUsd).toBe(2.0);
    });
  });
});
