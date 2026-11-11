import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LiveServerService } from '../../packages/tools/src/live-server';

describe('optional Live Server', () => {
  let directory: string;
  let service: LiveServerService;
  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'zwip-live-')));
    await mkdir(join(directory, 'public'));
    await writeFile(join(directory, 'public/index.html'), '<body>Hello</body>');
    await writeFile(join(directory, 'public/style.css'), 'body { color: red; }');
    service = new LiveServerService(directory);
  });
  afterEach(async () => {
    await service.stop();
    await rm(directory, { recursive: true, force: true });
  });

  it('serves a chosen workspace folder, injects reload only into HTML and handles HEAD', async () => {
    await mkdir(join(directory, 'public/nested folder'));
    await writeFile(join(directory, 'public/nested folder/index.html'), '<h1>Nested</h1>');
    const state = await service.start({ directory: 'public', port: 0 });
    expect(state).toMatchObject({ running: true, directory: join(directory, 'public') });
    const page = await fetch(state.url!);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(await page.text()).toMatch(/Hello.*EventSource/s);
    expect(await (await fetch(state.url + 'style.css')).text()).toBe('body { color: red; }');
    const head = await fetch(state.url!, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect((await fetch(state.url + 'missing')).status).toBe(404);
    expect((await fetch(state.url!, { method: 'POST' })).status).toBe(405);
    const redirect = await fetch(state.url + 'nested%20folder', { redirect: 'manual' });
    expect(redirect.status).toBe(301);
    expect(redirect.headers.get('location')).toBe('/nested%20folder/');
    expect(
      await (await fetch(new URL(redirect.headers.get('location')!, state.url))).text(),
    ).toContain('Nested');
  });

  it('blocks traversal, hidden files, symlink escapes and foreign browser origins', async () => {
    await writeFile(join(directory, 'secret.txt'), 'private');
    await writeFile(join(directory, 'public/.env'), 'private');
    await symlink(join(directory, 'secret.txt'), join(directory, 'public/escape.txt'));
    await symlink(join(directory, 'public/.env'), join(directory, 'public/hidden.txt'));
    const { url } = await service.start({ directory: 'public', port: 0 });
    for (const path of [
      '%2e%2e/secret.txt',
      '.env',
      'escape.txt',
      'hidden.txt',
      '%ZZ',
      '/evil.example',
    ]) {
      const status = await new Promise<number>((resolve, reject) => {
        request(url!, { path: '/' + path }, (response) => {
          response.resume();
          resolve(response.statusCode!);
        })
          .on('error', reject)
          .end();
      });
      expect(status).toBeGreaterThanOrEqual(400);
    }
    const foreignHost = await new Promise<number>((resolve, reject) => {
      request(url!, { headers: { Host: 'evil.example' } }, (response) => {
        response.resume();
        resolve(response.statusCode!);
      })
        .on('error', reject)
        .end();
    });
    expect(foreignHost).toBe(403);
    expect((await fetch(url!, { headers: { Origin: 'https://evil.example' } })).status).toBe(403);
    expect((await fetch(url!, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status).toBe(403);
  });

  it('sends live reload after a saved change and releases the port when stopped', async () => {
    const { url } = await service.start({ directory: 'public', port: 0 });
    const html = await (await fetch(url!)).text();
    const eventsPath = html.match(/new EventSource\("([^"]+)"\)/)![1];
    const abort = new AbortController();
    const events = await fetch(new URL(eventsPath, url), { signal: abort.signal });
    const reader = events.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(': connected');
    const reloaded = reader.read();
    await writeFile(join(directory, 'public/style.css'), 'body { color: blue; }');
    expect(new TextDecoder().decode((await reloaded).value)).toContain('data: reload');
    abort.abort();
    const port = Number(new URL(url!).port);
    expect(await service.stop()).toEqual({ running: false });
    expect((await service.start({ directory: 'public', port })).url).toBe(url);
    expect(await readFile(join(directory, 'public/index.html'), 'utf8')).toBe('<body>Hello</body>');
  });

  it('validates roots and ports, reports occupied ports and survives a failed start', async () => {
    await expect(service.start({ directory: '..', port: 0 })).rejects.toThrow(/workspace/i);
    await expect(service.start({ directory: 'public/index.html', port: 0 })).rejects.toThrow(
      /directory/i,
    );
    await expect(service.start({ directory: '.', port: -1 })).rejects.toThrow(/port/i);
    await expect(service.start({ directory: '.', port: '5500' })).rejects.toThrow(/port/i);
    const { url } = await service.start({ directory: 'public', port: 0 });
    const second = new LiveServerService(directory);
    try {
      await expect(
        second.start({ directory: 'public', port: Number(new URL(url!).port) }),
      ).rejects.toThrow(/port.*in use/i);
      expect(second.status()).toEqual({ running: false });
      await expect(service.start({ directory: 'public', port: 0 })).rejects.toThrow(
        /already running/i,
      );
    } finally {
      await second.stop();
    }
  });
});
