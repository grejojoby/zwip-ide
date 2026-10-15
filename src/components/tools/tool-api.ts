import { api } from '../../api';
import type { Connection } from '../../contracts';
export type { Connection } from '../../contracts';
export type ConnectionKind = Connection['kind'];
export const connectionApi = {
  list: api.connections,
  save: (connection: Connection, password?: string) => api.saveConnection(connection, password),
  delete: api.deleteConnection,
};
export const queryConsoleApi = {
  get: api.queryConsole,
  save: api.saveQueryConsole,
};
export const SELECTED_CONNECTION_KEY = 'zwip.database.selectedConnection';
export function toolRequest<T>(
  packageId: 'sql' | 'redis' | 'http' | 'go',
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  return api.toolRequest<T>(packageId, method, params);
}
