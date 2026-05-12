import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { startServer, broadcast } from "./server";
import type { Server } from "bun";

let server: Server;
let baseUrl: string;
let cleanup: ReturnType<typeof startServer>;

function url(path: string): string {
  return `${baseUrl}${path}`;
}

async function post(path: string, data: unknown) {
  const res = await fetch(url(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  return { status: res.status, body: await res.json() };
}

const YAML_CONFIG = `
name: test-sse
defaults:
  types:
    develop:
      type: agent
      params:
        prompt_template: "Implement"
tasks:
  - id: task1
    prompt: "Build X"
    actions: [develop]
`;

/**
 * Read SSE events from a response body until we have at least `count` events
 * or a timeout is reached.
 */
async function collectSSEEvents(
  res: Response,
  count: number,
  timeoutMs = 2000,
): Promise<{ event: string; data: unknown }[]> {
  const events: { event: string; data: unknown }[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const timeout = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));

  const readLoop = async () => {
    while (events.length < count) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Parse SSE frames from buffer
      const parts = buffer.split("\n\n");
      buffer = parts.pop()!; // keep incomplete frame

      for (const part of parts) {
        if (!part.trim()) continue;
        // Skip comments (heartbeats)
        if (part.startsWith(":")) continue;

        let eventName = "message";
        let dataStr = "";
        for (const line of part.split("\n")) {
          if (line.startsWith("event: ")) {
            eventName = line.slice(7);
          } else if (line.startsWith("data: ")) {
            dataStr = line.slice(6);
          }
        }
        if (dataStr) {
          events.push({ event: eventName, data: JSON.parse(dataStr) });
        }
      }
    }
  };

  await Promise.race([readLoop(), timeout]);
  reader.cancel();
  return events;
}

describe("v2 SSE", () => {
  beforeEach(() => {
    cleanup = startServer({ port: 0, noExecutor: true });
    server = cleanup.server;
    baseUrl = `http://localhost:${server.port}`;
  });

  afterEach(() => {
    clearInterval(cleanup.heartbeatInterval);
    server.stop(true);
    cleanup.db.close();
  });

  it("GET /events returns SSE stream with connected event", async () => {
    const res = await fetch(url("/events"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    const events = await collectSSEEvents(res, 1);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].event).toBe("connected");
  });

  it("GET /events receives broadcast events", async () => {
    const res = await fetch(url("/events"));
    // Wait for connected event
    await collectSSEEvents(res, 1, 500);

    // This creates a second connection to receive the broadcast
    const res2 = await fetch(url("/events"));

    // Broadcast an event
    broadcast(cleanup.state, "action_started", {
      action_id: "task1.develop",
      type: "agent",
    }, "task1.develop");

    // Collect: connected + action_started
    const events = await collectSSEEvents(res2, 2);
    expect(events.length).toBeGreaterThanOrEqual(2);
    const started = events.find((e) => e.event === "action_started");
    expect(started).toBeDefined();
    expect((started!.data as Record<string, unknown>).action_id).toBe("task1.develop");
  });

  it("GET /actions/:id/events filters events by action", async () => {
    await post("/import", { yaml: YAML_CONFIG, source_dir: "/tmp" });

    // Connect per-action stream for task1.develop
    const res = await fetch(url("/actions/task1.develop/events"));
    expect(res.status).toBe(200);

    // Broadcast event for different action — should be filtered out
    broadcast(cleanup.state, "action_started", {
      action_id: "other.action",
      type: "agent",
    }, "other.action");

    // Broadcast event for task1.develop — should come through
    broadcast(cleanup.state, "action_completed", {
      action_id: "task1.develop",
      condition: "pass",
      cost_usd: 0.01,
    }, "task1.develop");

    const events = await collectSSEEvents(res, 2, 1000);
    // Should have connected + action_completed (not action_started for other.action)
    const eventTypes = events.map((e) => e.event);
    expect(eventTypes).toContain("connected");
    expect(eventTypes).toContain("action_completed");
    expect(eventTypes).not.toContain("action_started");
  });

  it("GET /actions/:id/events returns 404 for missing action", async () => {
    const res = await fetch(url("/actions/nonexistent/events"));
    expect(res.status).toBe(404);
  });

  it("cleans up disconnected clients on write failure", async () => {
    // Manually add a client with a controller that throws on enqueue
    const closedController = {
      enqueue() {
        throw new Error("stream closed");
      },
    } as unknown as ReadableStreamDefaultController;

    const fakeClient = { controller: closedController };
    cleanup.state.sseClients.add(fakeClient);
    expect(cleanup.state.sseClients.size).toBe(1);

    // Broadcast — write failure should remove the client
    broadcast(cleanup.state, "executor_state", { state: "idle", pending_count: 0 });

    expect(cleanup.state.sseClients.size).toBe(0);
  });
});
