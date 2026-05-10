import { api } from './api';

let eventSource: EventSource | null = null;
const listeners: Map<string, ((data: any) => void)[]> = new Map();

// Disconnect gap tracking
let hadError = false;
let disconnectTimer: ReturnType<typeof setTimeout> | null = null;
let onReconnectCallback: (() => void) | null = null;

export const connectSSE = () => {
  if (eventSource) eventSource.close();

  const url = `${api.getBaseUrl()}/events`;
  eventSource = new EventSource(url);

  const SSE_EVENTS = [
    'action_started', 'action_completed', 'action_waiting',
    'edge_traversed', 'executor_state', 'connected', 'stats',
    'tool_use', 'unhandled_failure'
  ];

  SSE_EVENTS.forEach(name => {
    eventSource!.addEventListener(name, (event: MessageEvent) => {
      const data = JSON.parse(event.data);

      // On 'connected' event: if we had a gap, trigger reconnect refresh
      if (name === 'connected' && hadError) {
        hadError = false;
        // Cancel the delayed disconnect display
        if (disconnectTimer) { clearTimeout(disconnectTimer); disconnectTimer = null; }
        // Notify as connected
        const connHandlers = listeners.get('connected') || [];
        connHandlers.forEach(fn => fn(data));
        // Trigger full state refresh
        onReconnectCallback?.();
        return;
      }

      const handlers = listeners.get(name) || [];
      handlers.forEach(fn => fn(data));
    });
  });

  eventSource!.onerror = () => {
    hadError = true;
    // Only show "disconnected" after 5 seconds of sustained failure
    if (!disconnectTimer) {
      disconnectTimer = setTimeout(() => {
        const handlers = listeners.get('error') || [];
        handlers.forEach(fn => fn(null));
        disconnectTimer = null;
      }, 5000);
    }
  };
};

export const onSSE = (event: string, handler: (data: any) => void) => {
  if (!listeners.has(event)) listeners.set(event, []);
  listeners.get(event)!.push(handler);
};

/** Register a callback that fires when SSE reconnects after a gap. */
export const onReconnect = (callback: () => void) => {
  onReconnectCallback = callback;
};

export const disconnectSSE = () => {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  if (disconnectTimer) { clearTimeout(disconnectTimer); disconnectTimer = null; }
};

export const isSSEConnected = () => {
  return eventSource !== null && eventSource.readyState === EventSource.OPEN;
};
