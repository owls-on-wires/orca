/**
 * Ink view layer — a thin projection of `TuiState`. The presentational `App`
 * takes plain data and renders it (no stdin, so it unit-renders under
 * ink-testing-library); `InteractiveApp` wraps it with input handling, the SSE
 * attach, and the redraw coalescer.
 */

import React, { useEffect, useReducer, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import type { TuiState, BraidMessage, CircuitRow } from "./types";
import { initialState } from "./types";
import {
  applyEvent,
  seedActions,
  addUserMessage,
  type SseEvent,
} from "./store";
import { rowLine, formatCost, formatElapsed, burnRate } from "./format";
import { resolveKey, type Command } from "./keymap";
import { createCoalescer } from "./throttle";
import type { OrcaClient } from "./api";

// ---------------------------------------------------------------------------
// Presentational pieces
// ---------------------------------------------------------------------------

function TopBar({ state, now }: { state: TuiState; now: number }) {
  const running = state.stats.byStatus.running ?? 0;
  const total = state.stats.total || state.order.length;
  const elapsed = formatElapsed(now - state.startedAt);
  const dot = state.stats.executor === "running" ? "●" : state.stats.executor === "paused" ? "⏸" : "○";
  const color = state.stats.executor === "running" ? "green" : state.stats.executor === "paused" ? "yellow" : "gray";
  return (
    <Box justifyContent="space-between">
      <Text>
        {" "}orca · <Text bold>{state.buildName}</Text>
      </Text>
      <Text>
        <Text color={color}>{dot}{state.stats.executor}</Text>
        {"  "}{running}/{total}
        {"  "}{formatCost(state.stats.costUsd)}
        {"  "}{burnRate(state.stats.costUsd, now - state.startedAt)}
        {"  "}{elapsed}{" "}
      </Text>
    </Box>
  );
}

function BraidLine({ m }: { m: BraidMessage }) {
  const tag =
    m.kind === "user" ? <Text color="cyan">›</Text> :
    m.kind === "graph_edit" ? <Text color="magenta">▸</Text> :
    m.kind === "escalation" ? <Text color="red">⚠</Text> :
    m.kind === "result" ? <Text color="green">✓</Text> :
    <Text color="gray">{m.source}</Text>;

  if (m.kind === "graph_edit" && m.editCard) {
    return (
      <Text>
        {tag} <Text color={m.editCard.ok ? "magenta" : "red"}>circuit edit: {m.editCard.summary}</Text>
      </Text>
    );
  }
  return (
    <Text>
      {tag} <Text dimColor={m.kind === "text"}>{m.text}</Text>
    </Text>
  );
}

function Conversation({ state, input, width }: { state: TuiState; input: string; width: number }) {
  const visible = state.braid.slice(-Math.max(3, width));
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Text bold color="blue">CONVERSATION</Text>
      <Box flexDirection="column" flexGrow={1}>
        {visible.length === 0 ? <Text dimColor>Talk to Orca to reify work into the circuit…</Text> : null}
        {visible.map((m) => <BraidLine key={m.id} m={m} />)}
      </Box>
      <Box borderStyle="round" borderColor="gray">
        <Text>› {input}<Text inverse> </Text></Text>
      </Box>
    </Box>
  );
}

function CircuitRowLine({ row, selected }: { row: CircuitRow; selected: boolean }) {
  const line = rowLine(row);
  const color =
    row.status === "running" ? "yellow" :
    row.status === "completed" ? "green" :
    row.status === "failed" || row.status === "stuck" ? "red" :
    undefined;
  return <Text inverse={selected} color={color}>{line}</Text>;
}

function Circuit({ state }: { state: TuiState }) {
  const rows = state.order.map((id) => state.actions[id]).filter(Boolean);
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Text bold color="blue">CIRCUIT  [list]</Text>
      {rows.length === 0 ? <Text dimColor>no circuit yet</Text> : null}
      {rows.map((r) => <CircuitRowLine key={r.id} row={r} selected={state.selected === r.id} />)}
    </Box>
  );
}

function Detail({ row }: { row: CircuitRow | null }) {
  if (!row) return <Text dimColor>DETAIL · (select a node with ↑↓ + Enter)</Text>;
  return (
    <Box flexDirection="column">
      <Text bold>DETAIL · {row.id}</Text>
      <Text>{row.type} · {row.status} · {formatCost(row.costUsd)} · ×{row.iteration}</Text>
      <Text dimColor>→ {row.successors.join(", ") || "(terminal)"}</Text>
      {row.currentTool ? <Text color="yellow">⠿ {row.currentTool}</Text> : null}
    </Box>
  );
}

function BottomBar() {
  return (
    <Text dimColor>
      {" "}Tab focus · F2 pause · F9 abort · ↑↓ select · Enter detail · q detach (build keeps running){" "}
    </Text>
  );
}

// ---------------------------------------------------------------------------
// App — presentational, data-in
// ---------------------------------------------------------------------------

export function App({ state, now, input = "" }: { state: TuiState; now: number; input?: string }) {
  const width = 80;
  const selectedRow = state.selected ? state.actions[state.selected] ?? null : null;
  return (
    <Box flexDirection="column">
      <TopBar state={state} now={now} />
      <Box>
        <Box flexDirection="column" flexGrow={1} marginRight={1}>
          <Conversation state={state} input={input} width={width} />
        </Box>
        {state.hasCircuit ? (
          <Box flexDirection="column" flexGrow={1}>
            <Circuit state={state} />
            <Box marginTop={1}><Detail row={selectedRow} /></Box>
          </Box>
        ) : null}
      </Box>
      <BottomBar />
    </Box>
  );
}

// ---------------------------------------------------------------------------
// InteractiveApp — wires input, SSE, coalescing
// ---------------------------------------------------------------------------

export interface InteractiveAppProps {
  client: OrcaClient;
  buildName?: string;
  /** Injected for tests: skip the live SSE attach and drive events manually. */
  attach?: boolean;
  onDetach?: () => void;
}

export function InteractiveApp({ client, buildName = "orca", attach = true, onDetach }: InteractiveAppProps) {
  const { exit } = useApp();
  const stateRef = useRef<TuiState>(initialState(buildName, Date.now()));
  const [, forceRender] = useReducer((n: number) => n + 1, 0);
  const [input, setInput] = useState("");
  const [now, setNow] = useState(Date.now());

  const coalescer = useRef(createCoalescer({ onFlush: () => forceRender() }));

  const setState = (next: TuiState) => {
    stateRef.current = next;
    coalescer.current.schedule();
  };

  // Elapsed / burn-rate ticker.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Attach: seed from REST, then stream deltas over SSE.
  useEffect(() => {
    if (!attach) return;
    let detach = () => {};
    (async () => {
      const actions = await client.getActions();
      setState(seedActions(stateRef.current, actions));
      const conn = client.connectEvents((ev: SseEvent) => {
        setState(applyEvent(stateRef.current, ev));
      });
      detach = conn.detach;
    })();
    return () => { detach(); coalescer.current.cancel(); };
  }, [attach, client]);

  const doDetach = () => {
    coalescer.current.cancel();
    onDetach?.();
    exit();
  };

  const runCommand = (cmd: Command) => {
    const s = stateRef.current;
    switch (cmd.type) {
      case "detach": doDetach(); break;
      case "pause": client.pauseBuild(); break;
      case "resume": client.resumeBuild(); break;
      case "abort": client.pauseBuild(); break;
      case "cycle-focus":
        setState({ ...s, focus: s.focus === "conversation" ? "circuit" : "conversation", rev: s.rev + 1 });
        break;
      case "select-prev":
      case "select-next": {
        const ids = s.order;
        if (ids.length === 0) break;
        const idx = s.selected ? ids.indexOf(s.selected) : -1;
        const nextIdx = cmd.type === "select-next"
          ? Math.min(ids.length - 1, idx + 1)
          : Math.max(0, idx - 1);
        setState({ ...s, selected: ids[nextIdx], focus: "circuit", rev: s.rev + 1 });
        break;
      }
      case "steer":
        if (s.selected) {
          if (cmd.action === "retry") client.retryAction(s.selected);
          else if (cmd.action === "abort") client.skipAction(s.selected);
          else client.pauseBuild();
        }
        break;
      default: break;
    }
  };

  useInput((ch, key) => {
    // Text editing in the input box: printable chars, backspace, submit.
    if (key.return) {
      const text = input.trim();
      if (text) {
        setState(addUserMessage(stateRef.current, text));
        client.chat(text);
      }
      setInput("");
      return;
    }
    if (key.backspace || key.delete) { setInput((v) => v.slice(0, -1)); return; }

    const cmd = resolveKey(ch, key as any, {
      focus: stateRef.current.focus,
      editing: stateRef.current.focus === "conversation" && !key.ctrl,
      executorRunning: stateRef.current.stats.executor === "running",
    });

    if (cmd.type === "none") {
      // Not a command → treat as text if we're in the conversation pane.
      if (stateRef.current.focus === "conversation" && ch && !key.ctrl) setInput((v) => v + ch);
      return;
    }
    runCommand(cmd);
  });

  return <App state={stateRef.current} now={now} input={input} />;
}
