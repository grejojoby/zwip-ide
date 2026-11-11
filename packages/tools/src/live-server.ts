import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf',
};
export interface LiveServerStatus {
  running: boolean;
  directory?: string;
  url?: string;
  warning?: string;
}
function inside(root: string, path: string) {
  const part = relative(root, path);
  return part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part);
}
function hidden(path: string) {
  return path.split(/[\\/]/).some((part) => part.startsWith('.') || part === 'node_modules');
}

/** One static server per optional worker; the host owns worker/workspace lifetime. */
export class LiveServerService {
  private server?: Server;
  private watcher?: FSWatcher;
  private clients = new Set<ServerResponse>();
  private reloadTimer?: ReturnType<typeof setTimeout>;
  private state: LiveServerStatus = { running: false };
  private starting = false;
  private eventsPath = '';

  constructor(private workspace = process.cwd()) {}
  status(): LiveServerStatus {
    return { ...this.state };
  }

  async start(params: Record<string, unknown>): Promise<LiveServerStatus> {
    if (this.starting || this.server)
      throw new Error('Live Server is already running. Stop it first.');
    const directory = params.directory ?? '.';
    const port = params.port ?? 5500;
    if (typeof directory !== 'string' || !directory.trim()) throw new Error('Choose a directory.');
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535)
      throw new Error('Port must be a number from 0 to 65535.');
    this.starting = true;
    try {
      const workspace = await realpath(this.workspace);
      const root = await realpath(resolve(workspace, directory));
      if (!inside(workspace, root) || hidden(relative(workspace, root)))
        throw new Error('Choose a visible directory inside the workspace.');
      if (!(await stat(root)).isDirectory()) throw new Error('Choose a directory, not a file.');
      this.eventsPath = '/__zwip_live__/' + randomUUID();
      this.watcher = watch(root, { recursive: true }, (_event, name) => {
        if (name && hidden(String(name))) return;
        clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => {
          for (const client of this.clients) {
            if (!client.write('data: reload\n\n')) client.destroy();
          }
        }, 100);
      });
      this.watcher.on('error', () => {
        this.state.warning =
          'File watching stopped. Restart Live Server to restore automatic reload.';
      });
      const server = createServer((request, response) => {
        void this.respond(root, request, response).catch(() => {
          if (!response.headersSent) response.writeHead(404);
          response.end('File unavailable.');
        });
      });
      this.server = server;
      await new Promise<void>((accept, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          server.off('error', reject);
          accept();
        });
      });
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Could not determine server port.');
      this.state = { running: true, directory: root, url: `http://127.0.0.1:${address.port}/` };
      server.on('error', () => {
        this.state.warning = 'Server error. Stop and restart Live Server.';
      });
      return this.status();
    } catch (error) {
      await this.stop();
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE')
        throw new Error(`Port ${port} is already in use. Choose another port.`, { cause: error });
      throw error;
    } finally {
      this.starting = false;
    }
  }

  async openBrowser() {
    if (!this.state.url) throw new Error('Start Live Server first.');
    const [command, args] =
      process.platform === 'darwin'
        ? ['open', [this.state.url]]
        : process.platform === 'win32'
          ? ['rundll32.exe', ['url.dll,FileProtocolHandler', this.state.url]]
          : ['xdg-open', [this.state.url]];
    await promisify(execFile)(command, args);
    return this.status();
  }

  async stop(): Promise<LiveServerStatus> {
    this.watcher?.close();
    this.watcher = undefined;
    clearTimeout(this.reloadTimer);
    for (const client of this.clients) client.end();
    this.clients.clear();
    const server = this.server;
    this.server = undefined;
    this.state = { running: false };
    if (server)
      await new Promise<void>((done) => {
        server.close(() => done());
        server.closeAllConnections();
      });
    return this.status();
  }

  private async respond(root: string, request: IncomingMessage, response: ServerResponse) {
    const url = this.state.url;
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (
      !url ||
      request.headers.host !== new URL(url).host ||
      (request.headers.origin && request.headers.origin !== new URL(url).origin) ||
      request.headers['sec-fetch-site'] === 'cross-site'
    ) {
      response.writeHead(403).end('Local requests only.');
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    let pathname: string;
    try {
      pathname = decodeURIComponent((request.url ?? '/').split('?')[0]);
    } catch {
      response.writeHead(400).end();
      return;
    }
    if (pathname === this.eventsPath) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
      if (request.method === 'HEAD') {
        response.end();
        return;
      }
      response.write(': connected\n\n');
      this.clients.add(response);
      response.on('close', () => this.clients.delete(response));
      return;
    }
    if (
      !pathname.startsWith('/') ||
      pathname.startsWith('//') ||
      pathname.includes('\0') ||
      pathname.includes('\\') ||
      hidden(pathname)
    ) {
      response.writeHead(403).end();
      return;
    }
    let path = await realpath(resolve(root, '.' + pathname));
    if (!inside(root, path) || hidden(relative(root, path))) {
      response.writeHead(403).end();
      return;
    }
    if ((await stat(path)).isDirectory()) {
      if (!pathname.endsWith('/')) {
        response
          .writeHead(301, { Location: pathname.split('/').map(encodeURIComponent).join('/') + '/' })
          .end();
        return;
      }
      path = await realpath(resolve(path, 'index.html'));
    }
    if (!inside(root, path) || hidden(relative(root, path))) {
      response.writeHead(403).end();
      return;
    }
    if (!(await stat(path)).isFile()) {
      response.writeHead(404).end();
      return;
    }
    const file = await open(path, 'r');
    try {
      const info = await file.stat();
      if (!info.isFile()) {
        response.writeHead(404).end();
        return;
      }
      const extension = extname(path).toLowerCase();
      response.setHeader('Content-Type', mime[extension] ?? 'application/octet-stream');
      if (extension === '.html' || extension === '.htm') {
        if (info.size > 8 * 1024 * 1024) {
          response.writeHead(413).end('HTML exceeds 8 MiB.');
          return;
        }
        const html = await file.readFile('utf8');
        const script = `<script>(()=>{const events=new EventSource(${JSON.stringify(this.eventsPath)});events.onmessage=()=>location.reload();})();</script>`;
        const body = /<\/body\s*>/i.test(html)
          ? html.replace(/<\/body\s*>/i, script + '$&')
          : html + script;
        response.setHeader('Content-Length', Buffer.byteLength(body));
        response.end(request.method === 'HEAD' ? undefined : body);
      } else {
        response.setHeader('Content-Length', info.size);
        if (request.method === 'HEAD') response.end();
        else
          await new Promise<void>((done) => {
            const stream = file.createReadStream({ autoClose: false });
            stream.on('error', () => {
              response.destroy();
              done();
            });
            response.on('close', () => {
              stream.destroy();
              done();
            });
            stream.pipe(response);
          });
      }
    } finally {
      await file.close();
    }
  }
}
