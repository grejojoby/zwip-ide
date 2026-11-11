import { api } from '../api';
import type { DeploymentServer } from './deployment-contracts';
export function deploymentRequest<T>(
  root: string,
  method: string,
  params: Record<string, unknown> = {},
  server?: Pick<DeploymentServer, 'credentialId'>,
) {
  return api.toolRequest<T>(
    'deployment',
    method,
    { ...params, workspaceRoot: root },
    false,
    server?.credentialId,
  );
}
export const deploymentAutoKey = (root: string) => `zwip.${root}.deployment.autoUpload`;
