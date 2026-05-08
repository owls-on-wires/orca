import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { parseArgs, parseTopLevel, main } from "./cli";
import { OrcaDatabase } from "./db";
import { mkdirSync, writeFileSync, unlinkSync, rmSync } from "fs";
import { join } from "path";
import yaml from "js-yaml";

// ---------------------------------------------------------------------------
// Flag parsing
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
  test("parses command with no flags", () => {
    const result = parseArgs(["bun", "cli.ts", "serve"]);
    expect(result.command).toBe("serve");
    expect(result.positional).toEqual([]);
    expect(result.flags).toEqual({});
  });

  test("parses command with flags", () => {
    const result = parseArgs(["bun", "cli.ts", "serve", "--port", "8080", "--db", "/tmp/test.db"]);
    expect(result.command).toBe("serve");
    expect(result.flags.port).toBe("8080");
    expect(result.flags.db).toBe("/tmp/test.db");
  });

  test("parses positional args", () => {
    const result = parseArgs(["bun", "cli.ts", "run", "config.yaml", "--db", "test.db"]);
    expect(result.command).toBe("run");
    expect(result.positional).toEqual(["config.yaml"]);
    expect(result.flags.db).toBe("test.db");
  });

  test("parses boolean flags", () => {
    const result = parseArgs(["bun", "cli.ts", "run", "--help"]);
    expect(result.flags.help).toBe(true);
  });

  test("parses respond with positional args", () => {
    const result = parseArgs(["bun", "cli.ts", "respond", "task1.dev", "approved", "--notes", "looks good"]);
    expect(result.command).toBe("respond");
    expect(result.positional).toEqual(["task1.dev", "approved"]);
    expect(result.flags.notes).toBe("looks good");
  });
});

describe("parseTopLevel", () => {
  test("--version returns version command", () => {
    const result = parseTopLevel(["bun", "cli.ts", "--version"]);
    expect(result.command).toBe("version");
  });

  test("--help returns help command", () => {
    const result = parseTopLevel(["bun", "cli.ts", "--help"]);
    expect(result.command).toBe("help");
  });

  test("no args returns help command", () => {
    const result = parseTopLevel(["bun", "cli.ts"]);
    expect(result.command).toBe("help");
  });

  test("normal command passes through", () => {
    const result = parseTopLevel(["bun", "cli.ts", "status", "--tag", "foo"]);
    expect(result.command).toBe("status");
    expect(result.flags.tag).toBe("foo");
  });
});

// ---------------------------------------------------------------------------
// Config + DB integration
// ---------------------------------------------------------------------------

const TEST_DIR = join(import.meta.dir, "../../tmp/cli-test");
const TEST_DB = join(TEST_DIR, "test.db");

const SAMPLE_CONFIG = {
  name: "test-project",
  defaults: {
    types: {
      develop: {
        type: "agent",
        params: { prompt: "develop code" },
        edges: { pass: "next", fail: "first" },
      },
      eval: {
        type: "command",
        params: { command: "bun test" },
        edges: { pass: "next", fail: "first" },
      },
    },
  },
  tasks: [
    {
      id: "feature1",
      prompt: "implement feature 1",
      actions: ["develop", "eval"],
    },
  ],
};

function writeConfig(): string {
  const configPath = join(TEST_DIR, "test.orca.yaml");
  writeFileSync(configPath, yaml.dump(SAMPLE_CONFIG));
  return configPath;
}

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
});

describe("import command", () => {
  test("populates DB without executing", async () => {
    const configPath = writeConfig();

    // Capture console output
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      await main(["bun", "cli.ts", "import", configPath, "--db", TEST_DB]);
    } finally {
      console.log = origLog;
    }

    // Verify DB was populated
    const db = new OrcaDatabase(TEST_DB);
    const actions = db.listActions();
    expect(actions.length).toBe(2);
    expect(actions.map(a => a.id).sort()).toEqual(["feature1.develop", "feature1.eval"]);

    // Verify edges exist
    const edges = db.getEdgesFrom("feature1.develop");
    expect(edges.length).toBeGreaterThan(0);

    // Verify output message
    expect(logs.some(l => l.includes("Imported") && l.includes("2 actions"))).toBe(true);

    db.close();
  });
});

describe("status command", () => {
  test("reads DB and reports counts", async () => {
    const configPath = writeConfig();

    // First import
    await main(["bun", "cli.ts", "import", configPath, "--db", TEST_DB]);

    // Now run status
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      await main(["bun", "cli.ts", "status", "--db", TEST_DB]);
    } finally {
      console.log = origLog;
    }

    const output = logs.join("\n");
    expect(output).toContain("Total:");
    expect(output).toContain("Pending:");
    expect(output).toContain("Completed:");
  });

  test("filters by tag", async () => {
    const configPath = writeConfig();
    await main(["bun", "cli.ts", "import", configPath, "--db", TEST_DB]);

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      await main(["bun", "cli.ts", "status", "--db", TEST_DB, "--tag", "task:feature1"]);
    } finally {
      console.log = origLog;
    }

    const output = logs.join("\n");
    expect(output).toContain("Total:");
  });
});

describe("actions command", () => {
  test("lists actions", async () => {
    const configPath = writeConfig();
    await main(["bun", "cli.ts", "import", configPath, "--db", TEST_DB]);

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      await main(["bun", "cli.ts", "actions", "--db", TEST_DB]);
    } finally {
      console.log = origLog;
    }

    const output = logs.join("\n");
    expect(output).toContain("feature1.develop");
    expect(output).toContain("feature1.eval");
  });

  test("filters by status", async () => {
    const configPath = writeConfig();
    await main(["bun", "cli.ts", "import", configPath, "--db", TEST_DB]);

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      await main(["bun", "cli.ts", "actions", "--db", TEST_DB, "--status", "pending"]);
    } finally {
      console.log = origLog;
    }

    const output = logs.join("\n");
    expect(output).toContain("feature1.develop");
    // eval is inactive, should not appear
    expect(output).not.toContain("feature1.eval");
  });
});

describe("run command", () => {
  test("loads config and creates actions in DB", async () => {
    const configPath = writeConfig();

    // Run with a mock executor by using a config that has no real actions to run
    // The run command will load config, create DB entries, and start executor
    // Since we can't mock the executor in integration, just verify it loads properly
    // by checking DB state after import (run does same expansion)

    // We test the import path which shares the same config loading
    await main(["bun", "cli.ts", "import", configPath, "--db", TEST_DB]);

    const db = new OrcaDatabase(TEST_DB);
    const actions = db.listActions();
    expect(actions.length).toBe(2);
    expect(actions[0].type).toBe("agent");
    expect(actions[1].type).toBe("command");
    db.close();
  });
});
