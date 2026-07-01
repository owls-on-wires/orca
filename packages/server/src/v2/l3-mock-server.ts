/**
 * Hermetic Anthropic-wire mock for the L3 agent (test support).
 *
 * Speaks the real Anthropic streaming protocol over HTTP so `runL3Turn` can be
 * driven end-to-end — real `fetch`, SSE framing, fragmented `input_json_delta`
 * tool-arg accumulation, real tool execution (the governed graph-mutation), real
 * cost-from-usage — WITHOUT a paid key. Used by `l3-agent.live.test.ts` when no
 * `ANTHROPIC_API_KEY` is present; with a real key that test hits the live API.
 *
 * The "model" is a fixed loopcraft planner: on its first turn it calls
 * `apply_graph_edits` with a valid build↔test loop; thereafter it finalizes with
 * `StructuredOutput`. It does not parse the instruction — it exists to exercise
 * the wire + governance path, not to be a general emulator.
 */

interface WireToolUse { type: "tool_use"; id: string; name: string }
type WireBlock = WireToolUse | { type: string; [k: string]: unknown };
interface WireMessage { role: string; content: string | WireBlock[] }
interface WireRequest {
  messages: WireMessage[];
  tool_choice?: { type: string; name?: string };
}

interface PlannedTool { name: string; input: Record<string, unknown> }

/** The fixed loop the mock reifies: build↔test with a back-edge + terminal escape. */
const LOOP_EDITS = [
  { op: "add_action", id: "feature.build", type: "agent", prompt: "Write the feature", initial: true, max_iterations: 5 },
  { op: "add_action", id: "feature.test", type: "command", command: "bun test" },
  { op: "add_edge", from: "feature.build", to: "feature.test", condition: "pass" },
  { op: "add_edge", from: "feature.test", to: "feature.build", condition: "fail" },
];

function applyAlreadyDone(messages: WireMessage[]): boolean {
  for (const m of messages) {
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if ((b as WireToolUse).type === "tool_use" && (b as WireToolUse).name === "apply_graph_edits") return true;
    }
  }
  return false;
}

function planTurn(req: WireRequest): PlannedTool {
  if (req.tool_choice?.type === "tool" && req.tool_choice.name) {
    return { name: req.tool_choice.name, input: { status: "passed", summary: "Reified a build→test loop." } };
  }
  if (!applyAlreadyDone(req.messages)) {
    return { name: "apply_graph_edits", input: { edits: LOOP_EDITS } };
  }
  return { name: "StructuredOutput", input: { status: "passed", summary: "Reified a build→test loop." } };
}

// ---------------------------------------------------------------------------
// SSE emission — real Anthropic streaming wire format
// ---------------------------------------------------------------------------

function sseRecord(type: string, payload: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

function toolTurnRecords(tool: PlannedTool): string[] {
  const records: string[] = [];
  records.push(
    sseRecord("message_start", {
      message: {
        usage: { input_tokens: 200, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    }),
  );
  records.push(
    sseRecord("content_block_start", {
      index: 0,
      content_block: { type: "tool_use", id: `toolu_${Math.random().toString(36).slice(2, 10)}`, name: tool.name },
    }),
  );

  // Fragment the (large) JSON so accumulation-by-content-block-index is tested.
  const json = JSON.stringify(tool.input);
  const CHUNK = 9;
  for (let i = 0; i < json.length; i += CHUNK) {
    records.push(
      sseRecord("content_block_delta", {
        index: 0,
        delta: { type: "input_json_delta", partial_json: json.slice(i, i + CHUNK) },
      }),
    );
  }

  records.push(sseRecord("content_block_stop", { index: 0 }));
  records.push(sseRecord("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 60 } }));
  records.push(sseRecord("message_stop", {}));
  return records;
}

function toReadableStream(records: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= records.length) {
        controller.close();
        return;
      }
      const rec = records[i++];
      const mid = Math.floor(rec.length / 2);
      controller.enqueue(encoder.encode(rec.slice(0, mid)));
      controller.enqueue(encoder.encode(rec.slice(mid)));
    },
  });
}

export interface MockL3Server {
  url: string;
  port: number;
  readonly turns: number;
  close(): void;
}

export function startMockL3Server(): MockL3Server {
  let turns = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (!url.pathname.endsWith("/v1/messages")) {
        return new Response("not found", { status: 404 });
      }
      let body: WireRequest;
      try {
        body = (await req.json()) as WireRequest;
      } catch {
        return new Response(JSON.stringify({ type: "error", error: { message: "bad request" } }), { status: 400 });
      }
      turns++;
      const records = toolTurnRecords(planTurn(body));
      return new Response(toReadableStream(records), {
        status: 200,
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      });
    },
  });

  return {
    url: `http://localhost:${server.port}`,
    port: server.port ?? 0,
    get turns() {
      return turns;
    },
    close() {
      server.stop(true);
    },
  };
}
