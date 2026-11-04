import { browser, $ } from '@wdio/globals';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { updates } from '../../src/content/updates.ts';

const connection = {
  id: 'native-certificate',
  kind: 'mssql',
  name: 'Certificate acceptance fixture',
  config: {
    host: 'certificate.example.invalid',
    port: 1433,
    database: 'fixture',
    username: 'reader',
    tls: true,
    trustServerCertificate: false,
  },
};
const call = async (method, params = {}) => {
  const reply = await browser.executeAsync(
    (method, params, done) => {
      window.__TAURI__.core.invoke('ide_request', { method, params }).then(
        (result) => done({ result }),
        (error) => done({ error: String(error) }),
      );
    },
    method,
    params,
  );
  if (reply.error) throw new Error(reply.error);
  return reply.result;
};

describe('SQL certificate consent', () => {
  afterEach(async function () {
    if (this.currentTest?.state !== 'failed') return;
    mkdirSync('artifacts', { recursive: true });
    await browser.saveScreenshot(resolve('artifacts/native-sql-certificate-failure.png'));
  });
  it('shows the failed server, persists explicit trust and preserves it after reload', async () => {
    const workspace = process.env.ZWIP_E2E_WORKSPACE;
    assert.ok(existsSync(join(workspace, '.zwip-e2e-fixture')));
    const [handle] = await browser.getWindowHandles();
    await browser.switchToWindow(handle);
    await browser.waitUntil(() => browser.execute(() => Boolean(window.__TAURI__?.core)));
    await call('settings.set', { key: 'zwip.updates.lastSeen', value: updates[0].id });
    await call('settings.set', { key: 'zwip.recentRoots', value: [workspace] });
    await call('settings.set', { key: 'zwip.database.selectedConnection', value: connection.id });
    await call('connection.save', connection);
    await browser.refresh();
    await $('.recent-projects button').waitForDisplayed();
    // Simulate only the failing SQL worker boundary. Connection persistence uses the real core.
    await browser.execute((connectionId) => {
      const originalFetch = window.fetch;
      window.__certificateQueries = 0;
      window.__certificateTrusted = false;
      window.fetch = async (url, options) => {
        let args;
        if (String(url).endsWith('/ide_request') && typeof options?.body === 'string')
          args = JSON.parse(options.body);
        if (args?.method === 'connection.trustServerCertificate') {
          const response = await originalFetch.call(window, url, options);
          const saved = await response.clone().json();
          window.__certificateTrusted =
            Array.isArray(saved) &&
            saved.some((item) => item.id === connectionId && item.config.trustServerCertificate);
          return response;
        }
        if (
          args?.method === 'tool.request' &&
          args.params.packageId === 'sql' &&
          args.params.params.connectionId === connectionId
        ) {
          if (args.params.method === 'query') window.__certificateQueries++;
          const error = {
            code: -32603,
            message: 'SQL Server certificate verification failed. Self-signed certificate.',
          };
          return new Response(JSON.stringify(window.__certificateTrusted ? [] : error), {
            headers: {
              'Content-Type': 'application/json',
              'Tauri-Response': window.__certificateTrusted ? 'ok' : 'error',
            },
          });
        }
        return originalFetch.call(window, url, options);
      };
    }, connection.id);
    await $('.recent-projects button').click();
    await $('[aria-label="Filter project files"]').waitForDisplayed();
    await $('button[aria-label="Database tools"]').click();
    let popup = $('dialog[aria-label="Trust SQL Server certificate?"]');
    await popup.waitForDisplayed();
    assert.match(await popup.getText(), /certificate\.example\.invalid:1433/);
    assert.equal(
      (await call('connection.list')).find((item) => item.id === connection.id).config
        .trustServerCertificate,
      false,
    );
    mkdirSync('artifacts', { recursive: true });
    await browser.saveScreenshot(resolve('artifacts/native-sql-certificate-popup.png'));
    await popup.$('button=Cancel').click();
    await browser.waitUntil(async () => !(await popup.isExisting()));
    await $('button=Resolve certificate error…').click();
    popup = $('dialog[aria-label="Trust SQL Server certificate?"]');
    await popup.waitForDisplayed();
    await popup.$('button=Trust and save').click();
    await browser.waitUntil(async () => !(await popup.isExisting()));
    const saved = (await call('connection.list')).find((item) => item.id === connection.id);
    assert.deepEqual(saved.config, {
      ...connection.config,
      tls: true,
      trustServerCertificate: true,
    });
    assert.equal(await browser.execute(() => window.__certificateQueries), 0);
    await browser.refresh();
    await $('h1').waitForDisplayed();
    await browser.waitUntil(() => browser.execute(() => Boolean(window.__TAURI__?.core)));
    const reloaded = (await call('connection.list')).find((item) => item.id === connection.id);
    assert.deepEqual(reloaded, saved);
  });
});
