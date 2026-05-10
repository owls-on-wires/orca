import $ from 'jquery';

import { initializeState } from './state/state';
import * as modifiers from './state/modifiers';
import { main, initGraph, refreshGraph } from './views/main';
import { connectSSE, onSSE, onReconnect } from './services/events';
import { getHealth } from './services/endpoints';
import './styles/styles.css';

document.addEventListener('DOMContentLoaded', async () => {
  initializeState();

  const appElement = main('main-container');
  $('#app').empty().append(appElement);

  initGraph();

  // SSE connection state
  onSSE('connected', () => modifiers.setConnected(true));
  onSSE('error', () => modifiers.setConnected(false));
  onSSE('stats', (data) => modifiers.setStats(data));

  // SSE-driven graph refresh: when an action changes status, refresh the graph
  onSSE('action_started', () => refreshGraph());
  onSSE('action_completed', () => refreshGraph());
  onSSE('action_waiting', () => refreshGraph());

  // On SSE reconnect after a gap, fetch full state
  onReconnect(async () => {
    modifiers.setConnected(true);
    const stats = await getHealth().catch(() => null);
    if (stats) modifiers.setStats(stats);
    refreshGraph();
  });

  connectSSE();

  // Refresh on tab becoming visible (may have missed events while hidden)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      getHealth().then(stats => { if (stats) modifiers.setStats(stats); }).catch(() => {});
      refreshGraph();
    }
  });

  // Initial stats load
  const stats = await getHealth().catch(() => null);
  if (stats) modifiers.setStats(stats);
});
