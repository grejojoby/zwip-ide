import { createClient } from 'redis';
import { object, string, type Params } from './transport';
import { redisPreview } from './redis-preview';
const makeClient = (config: Params) =>
  createClient({
    socket: {
      host: typeof config.host === 'string' ? config.host : '127.0.0.1',
      port: Number(config.port ?? 6379),
      tls: config.tls === true ? true : undefined,
      connectTimeout: 10000,
      reconnectStrategy: false,
    },
    username: typeof config.username === 'string' ? config.username : undefined,
    password: typeof config.password === 'string' ? config.password : undefined,
    database: Number(config.database ?? 0),
  });
type Client = ReturnType<typeof makeClient>;
export class RedisService {
  private clients = new Map<string, Client>();
  private opening = new Map<string, Promise<Client>>();
  private client(params: Params): Promise<Client> {
    const config = object(params.connection);
    const id = string(config, 'id');
    const cached = this.clients.get(id);
    if (cached?.isReady) return Promise.resolve(cached);
    const opening = this.opening.get(id);
    if (opening) return opening;
    const client = makeClient(config);
    client.on('error', () => {});
    this.clients.set(id, client);
    const promise = client
      .connect()
      .then(() => {
        if (this.clients.get(id) !== client) {
          if (client.isOpen) client.destroy();
          throw new Error('Connection was closed.');
        }
        return client;
      })
      .catch((error) => {
        if (this.clients.get(id) === client) this.clients.delete(id);
        throw error;
      })
      .finally(() => {
        if (this.opening.get(id) === promise) this.opening.delete(id);
      });
    this.opening.set(id, promise);
    return promise;
  }
  async dispatch(method: string, params: Params) {
    if (method === 'disconnect') {
      const id = string(params, 'connectionId');
      const client = this.clients.get(id);
      this.clients.delete(id);
      this.opening.delete(id);
      if (client?.isOpen) client.destroy();
      return null;
    }
    const client = await this.client(params);
    if (method === 'keys') {
      const result = await client.scan(String(params.cursor ?? '0'), {
        MATCH: typeof params.pattern === 'string' ? params.pattern : '*',
        COUNT: 100,
      });
      if (
        result.keys.length > 2000 ||
        result.keys.reduce((sum, key) => sum + key.length, 0) > 512 * 1024
      ) {
        throw new Error('This scan batch exceeds the preview limit. Use a narrower key pattern.');
      }
      return { cursor: result.cursor, keys: result.keys, complete: result.cursor === '0' };
    }
    if (method === 'inspect') {
      const key = string(params, 'key');
      const type = await client.type(key);
      const ttl = await client.ttl(key);
      const cursor = String(params.cursor ?? '0');
      let value: unknown;
      let nextCursor = '0';
      let truncated = false;
      switch (type) {
        case 'string': {
          const size = await client.strLen(key);
          value = await client.getRange(key, 0, 65535);
          truncated = size > 65536;
          break;
        }
        case 'list': {
          const offset = Math.max(0, Number(params.offset ?? 0));
          value = await client.lRange(key, offset, offset + 99);
          truncated = (await client.lLen(key)) > offset + 100;
          break;
        }
        case 'hash': {
          const result = await client.hScan(key, cursor, { COUNT: 100 });
          value = result.entries;
          nextCursor = result.cursor;
          break;
        }
        case 'set': {
          const result = await client.sScan(key, cursor, { COUNT: 100 });
          value = result.members;
          nextCursor = result.cursor;
          break;
        }
        case 'zset': {
          const result = await client.zScan(key, cursor, { COUNT: 100 });
          value = result.members;
          nextCursor = result.cursor;
          break;
        }
        case 'stream':
          value = await client.xRange(key, '-', '+', { COUNT: 100 });
          truncated = (await client.xLen(key)) > 100;
          break;
        case 'none':
          value = null;
          break;
        default:
          throw new Error(`Inspection of Redis type ${type} is unsupported.`);
      }
      const preview = redisPreview(value);
      return {
        key,
        type,
        ttl,
        value: preview.value,
        cursor: nextCursor,
        truncated: truncated || preview.truncated,
        hasMore: type === 'list' ? truncated : nextCursor !== '0',
      };
    }
    throw new Error('Redis is read-only: only keys, inspect and disconnect are supported.');
  }
  dispose() {
    for (const client of this.clients.values()) {
      if (client.isOpen) client.destroy();
    }
    this.clients.clear();
    this.opening.clear();
  }
}
