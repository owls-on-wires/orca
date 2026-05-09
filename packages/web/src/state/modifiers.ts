import { update } from './state';
import { HealthData, ExecutorData } from '../types/types';
import { renderFootline } from '../views/main';

export const setTheme = (theme: 'light' | 'dark') => {
  update(draft => {
    draft.theme = theme;
  });
  document.documentElement.classList.toggle('theme-dark', theme === 'dark');
  document.documentElement.classList.toggle('theme-light', theme === 'light');
  document.body.classList.toggle('theme-dark', theme === 'dark');
  document.body.classList.toggle('theme-light', theme === 'light');
};

export const setConnected = (connected: boolean) => {
  update(draft => {
    draft.connected = connected;
  });
  renderFootline();
};

export const setHealth = (health: HealthData) => {
  update(draft => {
    draft.health = health;
  });
};

export const setExecutorState = (data: ExecutorData) => {
  update(draft => {
    draft.executorState = data;
  });
  renderFootline();
};
