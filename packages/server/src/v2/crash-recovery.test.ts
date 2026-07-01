import { test, expect } from "bun:test";
import { OrcaDatabase } from "./db";
import { Executor } from "./executor";
import { createAction } from "./schema";

// A crashed process (e.g. the server killed mid-build) leaves actions marked
// 'running' with no executor advancing them. On restart they must be re-queued,
// or the build stalls forever on an orphan.
test("recoverOrphanedRunning re-queues 'running' actions, leaves others", () => {
  const db = new OrcaDatabase(":memory:");
  db.insertAction(createAction({ id: "orphan", status: "running" }));
  db.insertAction(createAction({ id: "done", status: "completed" }));
  db.insertAction(createAction({ id: "waiting", status: "pending" }));
  db.insertAction(createAction({ id: "later", status: "inactive" }));

  const recovered = db.recoverOrphanedRunning();

  expect(recovered).toEqual(["orphan"]);
  expect(db.getAction("orphan")!.status).toBe("pending");
  expect(db.getAction("done")!.status).toBe("completed");
  expect(db.getAction("later")!.status).toBe("inactive");
  // getReadyActions now includes the recovered orphan so the executor resumes it
  expect(db.getReadyActions().map((a) => a.id).sort()).toEqual(["orphan", "waiting"]);
});

test("executor.recoverOrphanedActions delegates crash recovery", () => {
  const db = new OrcaDatabase(":memory:");
  db.insertAction(createAction({ id: "x", status: "running" }));
  const executor = new Executor(db, { projectDir: "." } as any);
  expect(executor.recoverOrphanedActions()).toEqual(["x"]);
  expect(db.getAction("x")!.status).toBe("pending");
});

test("recoverOrphanedRunning is a no-op when nothing is orphaned", () => {
  const db = new OrcaDatabase(":memory:");
  db.insertAction(createAction({ id: "a", status: "pending" }));
  db.insertAction(createAction({ id: "b", status: "completed" }));
  expect(db.recoverOrphanedRunning()).toEqual([]);
  expect(db.getAction("a")!.status).toBe("pending");
});
