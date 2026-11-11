import { isAbsolute, relative, sep } from 'node:path';
import type {
  DeploymentServer,
  DeploymentSettings,
} from '../../../../src/model/deployment-contracts';
import { object, string } from '../transport';
export const limits = { files: 5000, bytes: 1024 * 1024 * 1024, text: 1024 * 1024 };
export const hasControl = (value: string) =>
  [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
export function inside(root: string, path: string): boolean {
  const part = relative(root, path);
  return part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part);
}
export function relativePath(value: string, remote = false): string {
  if (
    value.length > 4096 ||
    hasControl(value) ||
    value.includes('\\') ||
    (!remote && value.startsWith('/'))
  )
    throw new Error('Use a relative path without traversal or control characters.');
  const parts = (remote ? value.replace(/^\/+/, '') : value).split('/');
  if (parts.includes('..')) throw new Error('Parent traversal is not allowed.');
  return parts.filter((part) => part && part !== '.').join('/');
}
function text(value: unknown, label: string, maximum = 4096): string {
  if (typeof value !== 'string' || value.length > maximum || hasControl(value))
    throw new Error(`Invalid ${label}.`);
  return value;
}
export function validId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9-]{1,80}$/i.test(value))
    throw new Error('Invalid deployment identity.');
  return value;
}
export function validateServer(input: unknown, requireTrust = true): DeploymentServer {
  const p = object(input);
  const id = validId(p.id);
  const name = text(p.name, 'server name', 120).trim();
  const host = text(p.host, 'host', 255).trim();
  const username = text(p.username, 'username', 255).trim();
  if (!name || !host || /\s/.test(host) || !username)
    throw new Error('Name, host and username are required.');
  if (!Number.isInteger(p.port) || Number(p.port) < 1 || Number(p.port) > 65535)
    throw new Error('Port must be from 1 to 65535.');
  if (!['password', 'key', 'agent'].includes(String(p.auth)))
    throw new Error('Unsupported authentication method.');
  const root = text(p.root, 'remote root');
  if (root !== '.' && (!root.startsWith('/') || root.split('/').includes('..')))
    throw new Error('Remote root must be an absolute path or . for the remote home.');
  const fingerprint = text(p.fingerprint, 'host fingerprint', 100);
  if (fingerprint && !/^SHA256:[A-Za-z0-9+/]{43}$/.test(fingerprint))
    throw new Error('Invalid SHA-256 host fingerprint.');
  if (requireTrust && !fingerprint) throw new Error('Review and trust the server key first.');
  if (!Array.isArray(p.mappings) || !p.mappings.length || p.mappings.length > 30)
    throw new Error('Add at least one path mapping (up to 30).');
  const mapped = new Set<string>();
  const mappings = p.mappings.map((input) => {
    const mapping = object(input);
    const local = relativePath(string(mapping, 'local')) || '.';
    const remote = relativePath(string(mapping, 'remote'), true);
    if (mapped.has(local)) throw new Error('Local path mappings must be unique.');
    mapped.add(local);
    return { local, remote };
  });
  const exclusions = (value: unknown, remote: boolean): string[] => {
    if (!Array.isArray(value) || value.length > 100) throw new Error('Invalid excluded paths.');
    return value.map((item) => {
      const path = relativePath(text(item, 'excluded path'), remote);
      if (!path) throw new Error('Exclude a specific path, not the entire root.');
      return path;
    });
  };
  const mode = (value: unknown) => {
    if (typeof value !== 'string' || (value !== '' && !/^[0-7]{3}$/.test(value)))
      throw new Error('Permissions must be blank or three octal digits, for example 644.');
    return value;
  };
  const excludeNames = text(p.excludeNames, 'name exclusions', 4096);
  if (excludeNames.split(';').length > 100) throw new Error('Use at most 100 name patterns.');
  const keyPath = text(p.keyPath, 'private key path');
  if (p.auth === 'key' && !keyPath) throw new Error('Choose a private key file.');
  return {
    id,
    name,
    host,
    username,
    port: Number(p.port),
    auth: p.auth as DeploymentServer['auth'],
    keyPath,
    root,
    fingerprint,
    ...(p.credentialId ? { credentialId: validId(p.credentialId) } : {}),
    mappings,
    excludedLocal: exclusions(p.excludedLocal, false),
    excludedRemote: exclusions(p.excludedRemote, true),
    excludeNames,
    preserveTimestamps: p.preserveTimestamps === true,
    fileMode: mode(p.fileMode),
    directoryMode: mode(p.directoryMode),
  };
}
export function validateSettings(input: unknown): DeploymentSettings {
  const value = object(input);
  if (!Array.isArray(value.servers) || value.servers.length > 50)
    throw new Error('Invalid server list (maximum 50).');
  const servers = value.servers.map((item) => validateServer(item));
  if (new Set(servers.map((server) => server.id)).size !== servers.length)
    throw new Error('Server identities must be unique.');
  const defaultId = text(value.defaultId, 'default server', 80);
  if (defaultId && !servers.some((server) => server.id === defaultId))
    throw new Error('Choose an existing default server.');
  if (value.autoUpload !== 'never' && value.autoUpload !== 'onSave')
    throw new Error('Invalid automatic upload mode.');
  if (value.autoUpload === 'onSave' && !defaultId)
    throw new Error('Choose a default server before enabling automatic upload.');
  return { revision: 0, servers, defaultId, autoUpload: value.autoUpload };
}
const subtree = (path: string, prefix: string) => path === prefix || path.startsWith(prefix + '/');
export function destination(server: DeploymentServer, local: string): string | null {
  const candidates = server.mappings
    .filter((mapping) => mapping.local === '.' || subtree(local, mapping.local))
    .sort((a, b) => b.local.length - a.local.length);
  const mapping = candidates[0];
  if (!mapping) return null;
  return [
    relativePath(mapping.remote, true),
    mapping.local === '.' ? local : local.slice(mapping.local.length + 1),
  ]
    .filter(Boolean)
    .join('/');
}
/** Bounded wildcard matcher: only * and ? are special, without regexp backtracking. */
function matches(name: string, pattern: string): boolean {
  let i = 0,
    j = 0,
    star = -1,
    checkpoint = 0;
  while (i < name.length) {
    if (pattern[j] === '?' || pattern[j] === name[i]) {
      i++;
      j++;
    } else if (pattern[j] === '*') {
      star = j++;
      checkpoint = i;
    } else if (star >= 0) {
      j = star + 1;
      i = ++checkpoint;
    } else return false;
  }
  while (pattern[j] === '*') j++;
  return j === pattern.length;
}
export function excluded(server: DeploymentServer, local: string, remote: string): boolean {
  const patterns = server.excludeNames
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean);
  return (
    server.excludedLocal.some((path) => subtree(local, path)) ||
    server.excludedRemote.some((path) => subtree(remote, path)) ||
    local.split('/').some((name) => patterns.some((pattern) => matches(name, pattern)))
  );
}
