import { createInterface } from 'node:readline';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Readable, Writable } from 'node:stream';
import type { EditorRequest, NavigationQuery } from '../../../src/contracts';
import {
  WebSemanticService,
  type DocumentUpdate,
  type InitializeParams,
  type WorkspaceSymbolsRequest,
} from './service';

type Request = { jsonrpc: '2.0'; id?: number | string | null; method: string; params?: unknown };
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** JSONL transport. Query mutations are ordered; cancellation bypasses the queue. */
export function startWorker(input: Readable = process.stdin, output: Writable = process.stdout) {
  const service = new WebSemanticService();
  const lines = createInterface({ input, crlfDelay: Infinity });
  const cancellations = new Set<string>();
  let queue = Promise.resolve();
  let stopped = false;
  const key = (id: unknown) => `${typeof id}:${String(id)}`;
  const send = (value: unknown) => {
    output.write(`${JSON.stringify(value)}\n`);
  };
  const error = (id: unknown, code: number, message: string) =>
    send({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

  async function dispatch(request: Request) {
    if (stopped) {
      if (request.id !== undefined) error(request.id, -32600, 'Worker has shut down.');
      return;
    }
    try {
      let result: unknown;
      const params = request.params;
      switch (request.method) {
        case 'initialize':
          if (
            !object(params) ||
            typeof params.root !== 'string' ||
            !Array.isArray(params.contexts) ||
            !Number.isSafeInteger(params.generation)
          )
            throw new TypeError('initialize requires root, contexts, and generation.');
          result = service.initialize(params as unknown as InitializeParams);
          break;
        case 'document.update':
          if (
            !object(params) ||
            typeof params.path !== 'string' ||
            typeof params.content !== 'string' ||
            !Number.isSafeInteger(params.revision)
          )
            throw new TypeError('document.update requires path, content, and revision.');
          result = service.updateDocument(params as unknown as DocumentUpdate);
          break;
        case 'workspace.index':
          result = service.indexWorkspace();
          break;
        case 'workspace.restore':
          result = service.indexWorkspace(true);
          break;
        case 'workspace.checkpoint':
          result = await service.checkpointWorkspace();
          break;
        case 'workspace.status':
          result = service.workspaceStatus();
          break;
        case 'document.close':
          if (!object(params) || typeof params.path !== 'string')
            throw new TypeError('document.close requires path.');
          result = service.closeDocument(params.path);
          break;
        case 'navigation.query':
          if (
            !object(params) ||
            typeof params.id !== 'string' ||
            typeof params.path !== 'string' ||
            typeof params.operation !== 'string' ||
            !object(params.position) ||
            !Number.isSafeInteger(params.position.line) ||
            !Number.isSafeInteger(params.position.character) ||
            !Number.isSafeInteger(params.documentRevision) ||
            !Number.isSafeInteger(params.workspaceGeneration) ||
            (params.contextIds !== undefined &&
              (!Array.isArray(params.contextIds) ||
                params.contextIds.some((id) => typeof id !== 'string')))
          )
            throw new TypeError('Invalid navigation query.');
          result = await service.query(
            params as unknown as NavigationQuery,
            () => cancellations.has(key(request.id)),
            params.reportProgress === true
              ? (batch) => send({ jsonrpc: '2.0', method: 'navigation.progress', params: batch })
              : undefined,
          );
          break;
        case 'editor.request':
          if (
            !object(params) ||
            typeof params.id !== 'string' ||
            typeof params.path !== 'string' ||
            typeof params.operation !== 'string' ||
            !Number.isSafeInteger(params.documentRevision) ||
            !Number.isSafeInteger(params.workspaceGeneration) ||
            (params.position !== undefined &&
              (!object(params.position) ||
                !Number.isSafeInteger(params.position.line) ||
                !Number.isSafeInteger(params.position.character)))
          )
            throw new TypeError('Invalid editor request.');
          result = await service.editor(params as unknown as EditorRequest, () =>
            cancellations.has(key(request.id)),
          );
          break;
        case 'workspace.symbols':
          if (
            !object(params) ||
            typeof params.id !== 'string' ||
            typeof params.query !== 'string' ||
            !Number.isSafeInteger(params.workspaceGeneration)
          )
            throw new TypeError('Invalid workspace symbol search.');
          result = await service.workspaceSymbols(
            params as unknown as WorkspaceSymbolsRequest,
            () => cancellations.has(key(request.id)),
          );
          break;
        case 'workspace.changed':
          if (
            !object(params) ||
            !Array.isArray(params.paths) ||
            params.paths.some((path) => typeof path !== 'string')
          )
            throw new TypeError('workspace.changed requires paths.');
          result = service.workspaceChanged(params.paths as string[]);
          break;
        case 'shutdown':
          service.dispose();
          stopped = true;
          result = null;
          lines.close();
          input.pause();
          break;
        default:
          if (request.id !== undefined)
            error(request.id, -32601, `Unknown method: ${request.method}`);
          return;
      }
      if (request.id !== undefined) send({ jsonrpc: '2.0', id: request.id, result });
    } catch (cause) {
      if (request.id !== undefined)
        error(
          request.id,
          cause instanceof TypeError ? -32602 : -32603,
          cause instanceof Error ? cause.message : String(cause),
        );
      else process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    } finally {
      cancellations.delete(key(request.id));
    }
  }

  lines.on('line', (line) => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      error(null, -32700, 'Invalid JSON.');
      return;
    }
    if (
      !object(value) ||
      value.jsonrpc !== '2.0' ||
      typeof value.method !== 'string' ||
      (value.id !== undefined &&
        value.id !== null &&
        typeof value.id !== 'string' &&
        typeof value.id !== 'number')
    ) {
      error(null, -32600, 'Invalid JSON-RPC request.');
      return;
    }
    const request = value as Request;
    if (request.method === '$/cancelRequest') {
      if (object(request.params) && 'id' in request.params)
        cancellations.add(key(request.params.id));
      return;
    }
    queue = queue.then(() => dispatch(request));
  });
  lines.on('close', () => {
    void queue.then(() => service.dispose());
  });
  return {
    dispose: () => {
      lines.close();
      service.dispose();
    },
    done: () => queue,
  };
}

function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    // Node resolves module URLs through symlinks, including macOS /var ->
    // /private/var. Compare file identities rather than the launch spelling.
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false; // Imported from stdin or another non-file entry point.
  }
}

if (isEntryPoint()) startWorker();
