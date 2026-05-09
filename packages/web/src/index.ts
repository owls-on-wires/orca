import $ from 'jquery';

import { initializeState } from './state/state';
import * as modifiers from './state/modifiers';
import { main, initGraph } from './views/main';
import { connectSSE, onSSE } from './services/events';
import { getHealth, getExecutorStatus } from './services/endpoints';
import './styles/styles.css';

document.addEventListener('DOMContentLoaded', async () => {
  initializeState();

  const appElement = main('main-container');
  $('#app').empty().append(appElement);

  initGraph();

  onSSE('connected', () => modifiers.setConnected(true));
  onSSE('error', () => modifiers.setConnected(false));

  connectSSE();

  const loadHealth = async () => {
    const health = await getHealth().catch(() => null);
    if (health) modifiers.setHealth(health);
  };

  const loadExecutor = async () => {
    const status = await getExecutorStatus().catch(() => null);
    if (status) modifiers.setExecutorState(status);
  };

  await loadHealth();
  await loadExecutor();

  setInterval(loadHealth, 10000);
  setInterval(loadExecutor, 5000);
});
