import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  writeIntervention,
  pollForResponse,
  clearIntervention,
  type InterventionRequest,
  type InterventionResponse,
} from "./index";

let orcaDir: string;

beforeEach(() => {
  orcaDir = mkdtempSync(join(tmpdir(), "orca-intervention-test-"));
});

afterEach(() => {
  rmSync(orcaDir, { recursive: true, force: true });
});

const sampleRequest: InterventionRequest = {
  timestamp: "2026-04-14T12:00:00Z",
  taskId: "dev_socket",
  cause: "test_bug",
  diagnosis: "The test asserts X but fixture has Y",
  evidence: "tests/dev_socket.rs:45",
  suggestedFix: "Change the assertion",
  supervisorReasoning: "The test was generated incorrectly",
};

describe("writeIntervention", () => {
  test("creates intervention.json in orca dir", async () => {
    await writeIntervention(orcaDir, sampleRequest);
    expect(existsSync(join(orcaDir, "intervention.json"))).toBe(true);
  });

  test("file contains the request data", async () => {
    await writeIntervention(orcaDir, sampleRequest);
    const raw = readFileSync(join(orcaDir, "intervention.json"), "utf8");
    const data = JSON.parse(raw);
    expect(data.taskId).toBe("dev_socket");
    expect(data.cause).toBe("test_bug");
    expect(data.diagnosis).toBe("The test asserts X but fixture has Y");
    expect(data.evidence).toBe("tests/dev_socket.rs:45");
  });

  test("works with minimal request (optional fields missing)", async () => {
    const minimal: InterventionRequest = {
      timestamp: "2026-04-14T12:00:00Z",
      taskId: "task1",
      cause: "environment_problem",
      diagnosis: "Missing dependency",
    };
    await writeIntervention(orcaDir, minimal);
    const data = JSON.parse(readFileSync(join(orcaDir, "intervention.json"), "utf8"));
    expect(data.taskId).toBe("task1");
    expect(data.evidence).toBeUndefined();
  });
});

describe("pollForResponse", () => {
  test("resolves when response file appears", async () => {
    const response: InterventionResponse = { action: "continue", note: "Fixed the test" };

    // Write the response after a short delay
    setTimeout(() => {
      writeFileSync(
        join(orcaDir, "intervention_response.json"),
        JSON.stringify(response),
      );
    }, 100);

    const result = await pollForResponse(orcaDir, 50);
    expect(result.action).toBe("continue");
    expect(result.note).toBe("Fixed the test");
  });

  test("returns skip action", async () => {
    const response: InterventionResponse = { action: "skip" };
    setTimeout(() => {
      writeFileSync(
        join(orcaDir, "intervention_response.json"),
        JSON.stringify(response),
      );
    }, 50);

    const result = await pollForResponse(orcaDir, 30);
    expect(result.action).toBe("skip");
  });

  test("returns abort action", async () => {
    const response: InterventionResponse = { action: "abort", note: "Kill it" };
    setTimeout(() => {
      writeFileSync(
        join(orcaDir, "intervention_response.json"),
        JSON.stringify(response),
      );
    }, 50);

    const result = await pollForResponse(orcaDir, 30);
    expect(result.action).toBe("abort");
    expect(result.note).toBe("Kill it");
  });
});

describe("clearIntervention", () => {
  test("removes both intervention files", async () => {
    writeFileSync(join(orcaDir, "intervention.json"), "{}");
    writeFileSync(join(orcaDir, "intervention_response.json"), "{}");

    await clearIntervention(orcaDir);
    expect(existsSync(join(orcaDir, "intervention.json"))).toBe(false);
    expect(existsSync(join(orcaDir, "intervention_response.json"))).toBe(false);
  });

  test("does not throw if files don't exist", async () => {
    await expect(clearIntervention(orcaDir)).resolves.toBeUndefined();
  });

  test("removes only the intervention files, not others", async () => {
    writeFileSync(join(orcaDir, "intervention.json"), "{}");
    writeFileSync(join(orcaDir, "state.json"), "{}");

    await clearIntervention(orcaDir);
    expect(existsSync(join(orcaDir, "state.json"))).toBe(true);
  });
});

describe("full lifecycle", () => {
  test("write → poll → clear", async () => {
    // 1. Write intervention request
    await writeIntervention(orcaDir, sampleRequest);
    expect(existsSync(join(orcaDir, "intervention.json"))).toBe(true);

    // 2. Simulate human response after delay
    setTimeout(() => {
      writeFileSync(
        join(orcaDir, "intervention_response.json"),
        JSON.stringify({ action: "continue", note: "Done" }),
      );
    }, 80);

    // 3. Poll for response
    const response = await pollForResponse(orcaDir, 40);
    expect(response.action).toBe("continue");

    // 4. Clear both files
    await clearIntervention(orcaDir);
    expect(existsSync(join(orcaDir, "intervention.json"))).toBe(false);
    expect(existsSync(join(orcaDir, "intervention_response.json"))).toBe(false);
  });
});
