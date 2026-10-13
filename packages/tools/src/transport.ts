import { createInterface } from 'node:readline';
export type Params = Record<string, unknown>;
export const object = (value: unknown): Params => {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Expected an object.');
  return value as Params;
};
export const string = (params: Params, key: string): string => {
  if (typeof params[key] !== 'string') throw new Error(`Missing string field: ${key}`);
  return params[key];
};
export function serve(
  dispatch: (method: string, params: Params) => unknown,
  dispose: () => void | Promise<void>,
) {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const send = (value: unknown) =>
    process.stdout.write(
      JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v)) + '\n',
    );
  lines.on('line', (line) => {
    void (async () => {
      let request: Params;
      try {
        request = object(JSON.parse(line));
      } catch {
        send({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Invalid JSON request.' },
        });
        return;
      }
      const id = request.id;
      try {
        let result: unknown;
        if (request.method === 'initialize') result = { ready: true };
        else if (request.method === 'shutdown') {
          await dispose();
          result = null;
          lines.close();
        } else if (request.method === 'tool.request') {
          const envelope = object(request.params);
          result = await dispatch(string(envelope, 'method'), object(envelope.params));
        } else {
          if (id === undefined) return;
          throw new Error('Unsupported tool method.');
        }
        if (id !== undefined) send({ jsonrpc: '2.0', id, result });
      } catch (error) {
        if (id !== undefined)
          send({
            jsonrpc: '2.0',
            id,
            error: {
              code: -32603,
              message: error instanceof Error ? error.message : String(error),
            },
          });
      }
    })();
  });
  lines.on('close', () => {
    void dispose();
  });
  process.on('SIGTERM', () => {
    void Promise.resolve(dispose()).finally(() => process.exit());
  });
}
