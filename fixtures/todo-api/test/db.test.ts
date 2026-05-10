import { expect, test, beforeEach } from "bun:test";
import { getDb, resetDb } from "../src/db";

beforeEach(() => resetDb());

test("getDb creates todos table", () => {
  const db = getDb();
  const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as any[];
  expect(tables.some(t => t.name === "todos")).toBe(true);
});

test("todos table has correct columns", () => {
  const db = getDb();
  const info = db.query("PRAGMA table_info(todos)").all() as any[];
  const colNames = info.map(c => c.name);
  expect(colNames).toContain("id");
  expect(colNames).toContain("title");
  expect(colNames).toContain("completed");
  expect(colNames).toContain("created_at");
});
