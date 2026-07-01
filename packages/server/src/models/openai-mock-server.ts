/**
 * Hermetic OpenAI Chat-Completions mock server (test support).
 *
 * Speaks the real OpenAI streaming wire protocol over HTTP so the Orca-owned
 * agent loop can be driven end-to-end against the `OpenAIProvider` — real
 * `fetch`, real SSE framing, real tool-arg fragment accumulation by tool index,
 * real `response_format` structured-output finalization, real usage/cost —
 * WITHOUT a paid API key. Used by `two-provider.live.test.ts` as a fallback
 * when no `OPENAI_API_KEY` is present.
 *
 * The planner mirrors the Anthropic mock: it reads the conversation, derives an
 * ordered tool plan from the first user instruction (reusing `derivePlan`),
 * emits the next un-done step as a function call, then finalizes via
 * `response_format` (a JSON content turn) once the loop forces the output tool.
 *
 * NOT a general OpenAI emulator — only the surface the loop consumes.
 */

import { derivePlan } from "./anthropic-mock-server";

// ---------------------------------------------------------------------------
// Wire shapes we consume from the request
// ---------------------------------------------------------------------------

interface WireToolCall { id: string; type?: string; function?: { name?: string; arguments?: string } }
interface WireMessage {
  role: string;
  content?: string | null;
  tool_calls?: WireToolCall[];
  tool_call_id?: string;
}
interface WireRequest {
  messages: WireMessage[];
  response_format?: { type?: string };
  tools?: unknown[];
}

interface PlannedTool { name: string; input: Record<string, unknown> }

// ---------------------------------------------------------------------------
// Planner — derive the agent's next move from the OpenAI-shaped conversation
// ---------------------------------------------------------------------------

function firstUserInstruction(messages: WireMessage[]): string {
  for (const m of messages) {
    if (m.role === "user" && typeof m.content === "string" && m.content.trim()) return m.content;
  }
  return "";
}

/** Count assistant tool_calls already emitted (i.e. plan steps done). */
function stepsDone(messages: WireMessage[]): number {
  let n = 0;
  for (const m of messages) {
    if (m.role === "assistant" && Array.isArray(m.tool_calls)) n += m.tool_calls.length;
  }
  return n;
}

/** Build the terminal structured output from what the `role:"tool"` results observed. */
function buildStructuredOutput(messages: WireMessage[]): Record<string, unknown> {
  const numbers: string[] = [];
  for (const m of messages) {
    if (m.role !== "tool") continue;
    const content = typeof m.content === "string" ? m.content : "";
    for (const d of content.match(/\d+/g) ?? []) if (!numbers.includes(d)) numbers.push(d);
  }
  const summary = numbers.length
    ? `Task complete. Values observed: ${numbers.join(", ")}.`
    : "Task complete.";
  return { status: "passed", summary, notes: "", issues: "" };
}

// ---------------------------------------------------------------------------
// SSE emission — real OpenAI streaming wire format
// ---------------------------------------------------------------------------

const USAGE = { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 0 } };

function sseData(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** A single assistant turn that calls one function, args fragmented across chunks. */
function toolCallRecords(tool: PlannedTool): string[] {
  const records: string[] = [];
  const callId = `call_${Math.random().toString(36).slice(2, 10)}`;
  records.push(
    sseData({
      choices: [{
        index: 0,
        delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id: callId, type: "function", function: { name: tool.name, arguments: "" } }] },
        finish_reason: null,
      }],
    }),
  );

  const json = JSON.stringify(tool.input);
  const CHUNK = 7;
  for (let i = 0; i < json.length; i += CHUNK) {
    records.push(
      sseData({
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: json.slice(i, i + CHUNK) } }] }, finish_reason: null }],
      }),
    );
  }

  records.push(sseData({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }));
  records.push(sseData({ choices: [], usage: USAGE }));
  records.push("data: [DONE]\n\n");
  return records;
}

/** A plain-text assistant turn (content), no tool calls. */
function textRecords(text: string, finish: string): string[] {
  return [
    sseData({ choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] }),
    sseData({ choices: [{ index: 0, delta: {}, finish_reason: finish }] }),
    sseData({ choices: [], usage: USAGE }),
    "data: [DONE]\n\n",
  ];
}

function planRecords(req: WireRequest): string[] {
  // Forced structured-output turn: the adapter set response_format, so return
  // the object as JSON message content (Layer B extracts it).
  if (req.response_format?.type === "json_schema") {
    return textRecords(JSON.stringify(buildStructuredOutput(req.messages)), "stop");
  }

  const instruction = firstUserInstruction(req.messages);
  const plan = derivePlan(instruction);
  const done = stepsDone(req.messages);
  if (done < plan.length) return toolCallRecords(plan[done]);

  // Plan complete but not yet forced — emit a no-tool text turn so the loop
  // drives its explicit final-answer turn (which sets response_format).
  return textRecords("Finalizing.", "stop");
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
      // Split each record across two chunks to exercise the SSE frame buffer.
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

export interface MockOpenAIServer {
  url: string;
  port: number;
  /** Number of /chat/completions turns served (one per model turn). */
  readonly turns: number;
  close(): void;
}

export function startMockOpenAIServer(): MockOpenAIServer {
  let turns = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (!url.pathname.endsWith("/chat/completions")) {
        return new Response("not found", { status: 404 });
      }
      let body: WireRequest;
      try {
        body = (await req.json()) as WireRequest;
      } catch {
        return new Response(JSON.stringify({ error: { message: "bad request" } }), { status: 400 });
      }
      turns++;
      const records = planRecords(body);
      return new Response(toReadableStream(records), {
        status: 200,
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      });
    },
  });

  return {
    url: `http://localhost:${server.port}/v1`,
    port: server.port,
    get turns() {
      return turns;
    },
    close() {
      server.stop(true);
    },
  };
}
