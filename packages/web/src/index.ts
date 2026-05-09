import $ from 'jquery';

import { initializeState } from './state/state';
import * as modifiers from './state/modifiers';
import { main, initGraph } from './views/main';
import { connectSSE, onSSE } from './services/events';
import { getHealth } from './services/endpoints';
import './styles/styles.css';

document.addEventListener('DOMContentLoaded', async () => {
  initializeState();

  const appElement = main('main-container');
  $('#app').empty().append(appElement);

  initGraph();

  onSSE('connected', () => modifiers.setConnected(true));
  onSSE('error', () => modifiers.setConnected(false));
  onSSE('stats', (data) => modifiers.setStats(data));

  connectSSE();

  const loadStats = async () => {
    const stats = await getHealth().catch(() => null);
    if (stats) modifiers.setStats(stats);
  };

  await loadStats();
});
