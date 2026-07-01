/**
 * Hermetic Anthropic Messages-API mock server (test support).
 *
 * Speaks the real Anthropic streaming wire protocol over HTTP so the
 * Orca-owned agent loop can be driven end-to-end — real `fetch`, real SSE
 * framing, real `input_json_delta` tool-arg accumulation, real tool execution,
 * real cost-from-usage — WITHOUT a paid API key and WITHOUT the `claude`
 * binary. Used by `engine/live.test.ts` as a fallback when no
 * `ANTHROPIC_API_KEY` is present; when a real key IS present that test hits the
 * live API instead.
 *
 * The "model" is a deterministic planner: it reads the conversation, derives an
 * ordered tool plan from the first user instruction, emits the next un-done
 * step, and finally emits a `StructuredOutput` call. Tool arguments are streamed
 * as fragmented `input_json_delta` chunks so the wire path is genuinely
 * exercised, not short-circuited.
 *
 * This is NOT a general Anthropic emulator — it only implements the surface the
 * agent loop consumes. Provider-side translation (system caching, tool schema,
 * headers) is accepted and ignored.
 */

// ---------------------------------------------------------------------------
// Wire shapes we consume from the request
// ---------------------------------------------------------------------------

interface WireToolResult { type: "tool_result"; content?: string; is_error?: boolean }
interface WireToolUse { type: "tool_use"; id: string; name: string }
type WireBlock = WireToolResult | WireToolUse | { type: string; [k: string]: unknown };
interface WireMessage { role: string; content: string | WireBlock[] }
interface WireRequest {
  messages: WireMessage[];
  tool_choice?: { type: string; name?: string };
}

interface PlannedTool { name: string; input: Record<string, unknown> }

// ---------------------------------------------------------------------------
// Planner — derive the agent's next move from the conversation
// ---------------------------------------------------------------------------

function firstUserInstruction(messages: WireMessage[]): string {
  for (const m of messages) {
    if (m.role === "user" && typeof m.content === "string") return m.content;
    if (m.role === "user" && Array.isArray(m.content)) {
      const text = m.content
        .filter((b): b is { type: "text"; text: string } => (b as any).type === "text")
        .map((b) => b.text)
        .join(" ");
      if (text.trim()) return text;
    }
  }
  return "";
}

/** Absolute (POSIX) paths mentioned in the instruction, punctuation-trimmed. */
function extractPaths(instruction: string): string[] {
  const matches = instruction.match(/\/[^\s"'`)]+/g) ?? [];
  return matches.map((p) => p.replace(/[.,;:]+$/, ""));
}

/**
 * Turn the natural-language instruction into an ordered plan of real-tool calls
 * (Read / Edit / Write). The final StructuredOutput step is implicit — emitted
 * once every planned step has been executed.
 */
export function derivePlan(instruction: string): PlannedTool[] {
  const path = extractPaths(instruction)[0];
  const plan: PlannedTool[] = [];

  // A write instruction is the scope-probe scenario: attempt exactly the write.
  const writeMatch = instruction.match(/write\s+"([^"]+)"/i);
  if (/\bwrite\b/i.test(instruction) && writeMatch && path) {
    plan.push({ name: "Write", input: { file_path: path, content: writeMatch[1] } });
    return plan;
  }

  if (/\bread\b/i.test(instruction) && path) {
    plan.push({ name: "Read", input: { file_path: path } });
  }

  const editMatch = instruction.match(/replace\s+"([^"]+)"\s+with\s+"([^"]+)"/i);
  if (editMatch && path) {
    plan.push({
      name: "Edit",
      input: { file_path: path, old_string: editMatch[1], new_string: editMatch[2] },
    });
    // "read it again to verify" -> a second Read.
    if (/again|verify/i.test(instruction)) {
      plan.push({ name: "Read", input: { file_path: path } });
    }
  }

  return plan;
}

/** Count assistant tool_use blocks already emitted (i.e. plan steps done). */
function stepsDone(messages: WireMessage[]): number {
  let n = 0;
  for (const m of messages) {
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const b of m.content) if ((b as any).type === "tool_use") n++;
  }
  return n;
}

/** Build the terminal StructuredOutput from what the tools observed. */
function buildStructuredOutput(messages: WireMessage[]): Record<string, unknown> {
  let anyError = false;
  const numbers: string[] = [];
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if ((b as any).type !== "tool_result") continue;
      const tr = b as WireToolResult;
      if (tr.is_error) anyError = true;
      const content = typeof tr.content === "string" ? tr.content : "";
      for (const d of content.match(/\d+/g) ?? []) if (!numbers.includes(d)) numbers.push(d);
    }
  }

  if (anyError) {
    return { status: "failed", summary: "blocked by scope" };
  }
  const summary = numbers.length
    ? `Task complete. Values observed: ${numbers.join(", ")}.`
    : "Task complete.";
  return { status: "passed", summary };
}

function planTurn(req: WireRequest): PlannedTool {
  // Honor a forced output tool (the loop's explicit final-answer turn).
  if (req.tool_choice?.type === "tool" && req.tool_choice.name) {
    return { name: req.tool_choice.name, input: buildStructuredOutput(req.messages) };
  }
  const instruction = firstUserInstruction(req.messages);
  const plan = derivePlan(instruction);
  const done = stepsDone(req.messages);
  if (done < plan.length) return plan[done];
  return { name: "StructuredOutput", input: buildStructuredOutput(req.messages) };
}

// ---------------------------------------------------------------------------
// SSE emission — real Anthropic streaming wire format
// ---------------------------------------------------------------------------

function sseRecord(type: string, payload: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

/**
 * Build the SSE records for one assistant turn that calls exactly one tool.
 * The tool's input JSON is fragmented across several `input_json_delta` records
 * to exercise the accumulator over the wire.
 */
function toolTurnRecords(tool: PlannedTool): string[] {
  const records: string[] = [];
  records.push(
    sseRecord("message_start", {
      message: {
        usage: {
          input_tokens: 120,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    }),
  );
  records.push(
    sseRecord("content_block_start", {
      index: 0,
      content_block: { type: "tool_use", id: `toolu_${Math.random().toString(36).slice(2, 10)}`, name: tool.name },
    }),
  );

  // Fragment the JSON so accumulation-by-content-block-index is genuinely tested.
  const json = JSON.stringify(tool.input);
  const CHUNK = 7;
  for (let i = 0; i < json.length; i += CHUNK) {
    records.push(
      sseRecord("content_block_delta", {
        index: 0,
        delta: { type: "input_json_delta", partial_json: json.slice(i, i + CHUNK) },
      }),
    );
  }

  records.push(sseRecord("content_block_stop", { index: 0 }));
  records.push(
    sseRecord("message_delta", {
      delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 35 },
    }),
  );
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
      // Split some records across two chunks to exercise the SSE frame buffer.
      const rec = records[i++];
      const mid = Math.floor(rec.length / 2);
      controller.enqueue(encoder.encode(rec.slice(0, mid)));
      controller.enqueue(encoder.encode(rec.slice(mid)));
    },
  });
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export interface MockAnthropicServer {
  url: string;
  port: number;
  /** Number of /v1/messages turns served (one per model turn). */
  readonly turns: number;
  close(): void;
}

export function startMockAnthropicServer(): MockAnthropicServer {
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
        return new Response(JSON.stringify({ type: "error", error: { message: "bad request" } }), {
          status: 400,
        });
      }
      turns++;
      const tool = planTurn(body);
      const records = toolTurnRecords(tool);
      return new Response(toReadableStream(records), {
        status: 200,
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      });
    },
  });

  return {
    url: `http://localhost:${server.port}`,
    port: server.port,
    get turns() {
      return turns;
    },
    close() {
      server.stop(true);
    },
  };
}
