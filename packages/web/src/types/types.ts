export interface State {
  theme: 'light' | 'dark';
  connected: boolean;
  health: HealthData | null;
  executorState: ExecutorData | null;
}

export interface HealthData {
  version: string;
  uptime: number;
  actions: Record<string, number>;
}

export interface ExecutorData {
  state: string;
  active_action: string | null;
  pending: number;
  total: number;
}
