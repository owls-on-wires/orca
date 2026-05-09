export interface State {
  theme: 'light' | 'dark';
  connected: boolean;
  stats: StatsData | null;
  executorState: ExecutorData | null;
}

export interface StatsData {
  version: string;
  uptime: number;
  executor: string;
  actions: Record<string, number>;
  total_cost_usd: number;
}

export interface ExecutorData {
  state: string;
  active_action: string | null;
  pending: number;
  total: number;
}
