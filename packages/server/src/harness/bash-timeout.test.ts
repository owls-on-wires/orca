import { test, expect } from "bun:test";
import { bashTool } from "./tools";

// Regression: a build agent that boots a server in-band (`server & ... wait`, or
// any long-lived process) must not hang the Bash tool — the read of stdout only
// resolves when the pipe CLOSES, which a live server never does. The tool must
// race the read against the timeout and return promptly.
test("bashTool returns promptly when a command spawns a long-lived process", async () => {
  const t0 = Date.now();
  const r: any = await bashTool(
    { command: "sleep 60 & echo up; wait", timeout: 2 },
    { cwd: "/tmp", env: process.env } as any,
  );
  expect(Date.now() - t0).toBeLessThan(10000); // returned, did not hang ~60s
  expect(r.isError).toBe(true);
  expect(r.output).toContain("timed out");
});

test("bashTool returns normal command output", async () => {
  const r: any = await bashTool(
    { command: "echo hello", timeout: 5 },
    { cwd: "/tmp", env: process.env } as any,
  );
  expect(r.output).toBe("hello");
  expect(r.isError).toBeUndefined();
});

test("bashTool reports a non-zero exit code", async () => {
  const r: any = await bashTool(
    { command: "echo oops; exit 3", timeout: 5 },
    { cwd: "/tmp", env: process.env } as any,
  );
  expect(r.output).toContain("Exit code: 3");
});
