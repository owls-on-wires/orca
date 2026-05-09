import { update } from './state';
import { StatsData, ExecutorData } from '../types/types';
import { renderFootline, renderStatsStrip } from '../views/main';

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

export const setStats = (stats: StatsData) => {
  update(draft => {
    draft.stats = stats;
  });
  renderStatsStrip();
  renderFootline();
};

export const setExecutorState = (data: ExecutorData) => {
  update(draft => {
    draft.executorState = data;
  });
  renderFootline();
};
