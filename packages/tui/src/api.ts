/**
 * Thin client of the `orca serve` daemon. The TUI owns NO build state — it
 * attaches over REST + SSE and detaches by simply dropping the connection
 * (spec-tui: "detaches on quit — the build keeps running"). Everything here is
 * transport; state lives in the daemon and is projected through `store.ts`.
 */

import type { RawAction, SseEvent } from "./store";

export interface ChatResponse {
  message_id: string;
  status: string;
}

export class OrcaClient {
  constructor(private readonly baseUrl: string) {}

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/$/, "")}${path}`;
  }

  async health(): Promise<Record<string, unknown>> {
    const r = await fetch(this.url("/health"));
    return (await r.json()) as Record<string, unknown>;
  }

  async getActions(): Promise<RawAction[]> {
    const r = await fetch(this.url("/actions"));
    if (!r.ok) return [];
    return (await r.json()) as RawAction[];
  }

  async chat(message: string, opts: { projectId?: string; taskTag?: string; model?: string } = {}): Promise<ChatResponse> {
    const r = await fetch(this.url("/chat"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        project_id: opts.projectId,
        task_tag: opts.taskTag,
        model: opts.model,
      }),
    });
    return (await r.json()) as ChatResponse;
  }

  async pauseBuild(): Promise<void> { await fetch(this.url("/executor/pause"), { method: "POST" }); }
  async resumeBuild(): Promise<void> { await fetch(this.url("/executor/resume"), { method: "POST" }); }
  async retryAction(id: string): Promise<void> { await fetch(this.url(`/actions/${encodeURIComponent(id)}/retry`), { method: "POST" }); }
  async skipAction(id: string): Promise<void> { await fetch(this.url(`/actions/${encodeURIComponent(id)}/skip`), { method: "POST" }); }

  /**
   * Attach to the global SSE stream. Returns a `detach()` that drops the
   * connection without touching the daemon. Runs the read loop in the background;
   * errors after detach are swallowed.
   */
  connectEvents(onEvent: (ev: SseEvent) => void): { detach: () => void; done: Promise<void> } {
    const controller = new AbortController();
    const done = this.readStream(controller.signal, onEvent).catch(() => {});
    return { detach: () => controller.abort(), done };
  }

  private async readStream(signal: AbortSignal, onEvent: (ev: SseEvent) => void): Promise<void> {
    const res = await fetch(this.url("/events"), { signal, headers: { Accept: "text/event-stream" } });
    if (!res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const ev = parseFrame(frame);
        if (ev) onEvent(ev);
      }
    }
  }
}

/** Parse one SSE frame (`event:` + `data:` lines) into `{event,data}`. */
export function parseFrame(frame: string): SseEvent | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) continue; // comment / heartbeat
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  try {
    return { event, data: JSON.parse(dataLines.join("\n")) };
  } catch {
    return null;
  }
}
