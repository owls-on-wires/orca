import { api } from './api';

export const getHealth = async () => {
  return api.get<{
    version: string;
    uptime: number;
    actions: Record<string, number>;
  }>('/health');
};

export const getActions = async (params?: { tag?: string; status?: string; type?: string }) => {
  const query = new URLSearchParams();
  if (params?.tag) query.set('tag', params.tag);
  if (params?.status) query.set('status', params.status);
  if (params?.type) query.set('type', params.type);
  const qs = query.toString();
  return api.get<any[]>(`/actions${qs ? '?' + qs : ''}`);
};

export const getExecutorStatus = async () => {
  return api.get<{
    state: string;
    active_action: string | null;
    pending: number;
    total: number;
  }>('/executor/status');
};
