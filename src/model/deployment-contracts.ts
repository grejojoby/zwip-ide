export interface DeploymentMapping {
  local: string;
  remote: string;
}
export interface DeploymentServer {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth: 'password' | 'key' | 'agent';
  keyPath: string;
  root: string;
  fingerprint: string;
  credentialId?: string;
  mappings: DeploymentMapping[];
  excludedLocal: string[];
  excludedRemote: string[];
  excludeNames: string;
  preserveTimestamps: boolean;
  fileMode: string;
  directoryMode: string;
}
export interface DeploymentSettings {
  revision: number;
  servers: DeploymentServer[];
  defaultId: string;
  autoUpload: 'never' | 'onSave';
}
export const deploymentExclusions =
  '.git;.svn;.hg;.idea;.zwip;node_modules;dist;target;.env;.env.*;*.pem;*.key;.DS_Store';
export function newDeploymentServer(id: string): DeploymentServer {
  return {
    id,
    name: '',
    host: '',
    port: 22,
    username: '',
    auth: 'agent',
    keyPath: '',
    root: '.',
    fingerprint: '',
    mappings: [{ local: '.', remote: '' }],
    excludedLocal: [],
    excludedRemote: [],
    excludeNames: deploymentExclusions,
    preserveTimestamps: false,
    fileMode: '',
    directoryMode: '',
  };
}
export interface DeploymentFile {
  key: string;
  local: string;
  remote: string;
  bytes: number;
  hash: string;
  remoteHash: string | null;
  remoteMode?: number;
  mtime: number;
  action: 'create' | 'replace' | 'unchanged' | 'conflict' | 'blocked';
  reason?: string;
}
export interface DeploymentPlan {
  id: string;
  serverId: string;
  serverName: string;
  root: string;
  revision: number;
  files: DeploymentFile[];
  excluded: number;
  createdAt: number;
}
export interface DeploymentTransfer {
  key: string;
  local: string;
  remote: string;
  status:
    | 'queued'
    | 'uploading'
    | 'publishing'
    | 'uploaded'
    | 'unchanged'
    | 'failed'
    | 'cancelled'
    | 'unknown';
  bytes: number;
  sent: number;
  message?: string;
  intendedHash?: string;
}
export interface DeploymentJob {
  id: string;
  serverId: string;
  serverName: string;
  status: 'running' | 'completed' | 'partial' | 'cancelled' | 'interrupted';
  startedAt: number;
  finishedAt?: number;
  files: DeploymentTransfer[];
}
export interface DeploymentRemoteEntry {
  name: string;
  path: string;
  kind: 'directory' | 'file' | 'link' | 'other';
  bytes: number;
  modified: number;
}
export interface DeploymentSavedFile {
  path: string;
  hash: string;
  revision: number;
  workspaceGeneration: number;
}
