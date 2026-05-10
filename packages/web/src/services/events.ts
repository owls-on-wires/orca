import { api } from './api';

let eventSource: EventSource | null = null;
const listeners: Map<string, ((data: any) => void)[]> = new Map();

export const connectSSE = () => {
  if (eventSource) eventSource.close();

  const url = `${api.getBaseUrl()}/events`;
  eventSource = new EventSource(url);

  const SSE_EVENTS = [
    'action_started', 'action_completed', 'action_waiting',
    'edge_traversed', 'executor_state', 'connected', 'stats',
    'tool_use'
  ];

  SSE_EVENTS.forEach(name => {
    eventSource!.addEventListener(name, (event: MessageEvent) => {
      const data = JSON.parse(event.data);
      const handlers = listeners.get(name) || [];
      handlers.forEach(fn => fn(data));
    });
  });

  eventSource!.onerror = () => {
    const handlers = listeners.get('error') || [];
    handlers.forEach(fn => fn(null));
  };
};

export const onSSE = (event: string, handler: (data: any) => void) => {
  if (!listeners.has(event)) listeners.set(event, []);
  listeners.get(event)!.push(handler);
};

export const disconnectSSE = () => {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
};

export const isSSEConnected = () => {
  return eventSource !== null && eventSource.readyState === EventSource.OPEN;
};
