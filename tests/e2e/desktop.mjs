import { browser, $ } from '@wdio/globals';
import assert from 'node:assert/strict';
import { resolve, join, dirname } from 'node:path';
import { readFileSync, mkdirSync, existsSync, writeFileSync, statSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { arch, cpus, release } from 'node:os';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { updates } from '../../src/content/updates.ts';
const workspace = process.env.ZWIP_E2E_WORKSPACE;
const databasePath = join(dirname(workspace), 'native.sqlite');
// The embedded driver's direct-eval channel cannot resolve asynchronous IPC on
// this WKWebView. The callback route invokes the same real native command.
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
const install = async (id) => {
  const packages = await call('package.install', { path: resolve('dist/packages', id) });
  const name = packages.find((item) => item.id === id)?.name;
  assert.ok(name, `Installed package ${id} must be listed.`);
  await call('package.enable', { id, enabled: false });
  // Fixture installation avoids an OS file dialog; activation uses the real
  // Packages UI so existing editor grammar caches receive its change event.
  await $('footer').$('button=Packages').click();
  const dialog = $('dialog[aria-label="Language & tool packages"]');
  await dialog.waitForDisplayed();
  await browser.waitUntil(async () => (await dialog.$$('.package-item')).length > 0);
  const rows = await dialog.$$('.package-item');
  let row;
  for (const candidate of rows) {
    if ((await candidate.$('h3').getText()).startsWith(name)) {
      row = candidate;
      break;
    }
  }
  assert.ok(row, `Installed package ${name} must appear in the package UI.`);
  await row.$('button=Enable').waitForEnabled();
  await row.$('button=Enable').click();
  await row.$('button=Disable').waitForEnabled({ timeout: 20000 });
  await dialog.$('button=Done').click();
  await browser.waitUntil(async () => !(await dialog.isExisting()));
};
const screenshot = async (name) => {
  mkdirSync('artifacts', { recursive: true });
  await browser.saveScreenshot(resolve('artifacts', `native-${name}.png`));
};
const editorHasFocus = () =>
  browser.execute(() => Boolean(document.activeElement?.closest('.cm-content')));
const waitForHighlightedToken = async (editorLabel, token) => {
  await browser.waitUntil(
    () =>
      browser.execute(
        (editorLabel, token) => {
          const editor = document.querySelector(`[aria-label="${editorLabel}"]`);
          if (!editor) return false;
          const plain = getComputedStyle(editor).color;
          return Array.from(editor.querySelectorAll('.cm-line span')).some(
            (span) => span.textContent === token && getComputedStyle(span).color !== plain,
          );
        },
        editorLabel,
        token,
      ),
    { timeout: 15000, timeoutMsg: `${token} was not highlighted in ${editorLabel}.` },
  );
};
const clickEditorText = async (editorLabel, text, occurrence = 0, metaKey = false) => {
  const point = await browser.execute(
    (editorLabel, text, occurrence) => {
      const editor = document.querySelector(`[aria-label="${editorLabel}"]`);
      if (!editor) throw new Error(`Missing editor ${editorLabel}`);
      const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        let index = -1;
        while ((index = node.textContent.indexOf(text, index + 1)) !== -1) {
          if (occurrence-- !== 0) continue;
          const range = document.createRange();
          range.setStart(node, index);
          range.setEnd(node, index + text.length);
          const rect = range.getBoundingClientRect();
          return {
            x: Math.round(rect.x + rect.width / 2),
            y: Math.round(rect.y + rect.height / 2),
          };
        }
      }
      throw new Error(`Missing text ${text} in ${editorLabel}`);
    },
    editorLabel,
    text,
    occurrence,
  );
  // Deliver the modifier with the pointer event in one dispatch. The embedded
  // driver's separate key/pointer sources do not reliably share modifier state.
  await browser.execute(
    ({ x, y, metaKey }) => {
      const target = document.elementFromPoint(x, y);
      if (!target) throw new Error('The navigation target is outside the viewport.');
      if (!target.closest('.cm-content'))
        throw new Error(
          `Navigation coordinates resolved to ${target.tagName} ${target.textContent?.slice(0, 80)} at ${x},${y}`,
        );
      for (const type of ['mousedown', 'mouseup', 'click'])
        target.dispatchEvent(
          new MouseEvent(type, {
            clientX: x,
            clientY: y,
            button: 0,
            metaKey,
            bubbles: true,
            cancelable: true,
          }),
        );
      return true;
    },
    { ...point, metaKey },
  );
};
const cmdClickText = (editorLabel, text, occurrence = 0) =>
  clickEditorText(editorLabel, text, occurrence, true);
// The embedded driver dispatches option.click(), which lacks the browser's
// select default action. Reproduce that action and its real React change event.
const selectValue = async (selector, value) => {
  const selected = await browser.execute(
    (selector, value) => {
      const element = document.querySelector(selector);
      if (
        !(element instanceof HTMLSelectElement) ||
        !Array.from(element.options).some((option) => option.value === value)
      )
        return false;
      element.value = value;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    },
    selector,
    value,
  );
  assert.equal(selected, true);
  // A controlled select may retain its previous value while an asynchronous
  // browse request completes. Observe the committed UI state separately.
  await browser.waitUntil(async () => (await $(selector).getValue()) === value, {
    timeout: 20000,
    timeoutMsg: `The selected value did not settle for ${selector}.`,
  });
};
// xterm's screen-reader mode intentionally ignores insertText input events.
// The embedded driver omits keypress entirely. Supply the missing keyboard
// event sequence in the real webview; never call terminal.write or a mock.
const typeTerminal = async (text) => {
  await browser.execute((text) => {
    const target = document.querySelector('.terminal-host .xterm-helper-textarea');
    target.focus();
    for (const key of text) {
      const code = key === ' ' ? 'Space' : key === '>' ? 'Period' : `Key${key.toUpperCase()}`;
      const keyCode = key === ' ' ? 32 : key === '>' ? 190 : key.toUpperCase().charCodeAt(0);
      const options = {
        key,
        code,
        keyCode,
        which: keyCode,
        shiftKey: key === '>',
        bubbles: true,
        cancelable: true,
      };
      target.dispatchEvent(new KeyboardEvent('keydown', options));
      target.dispatchEvent(
        new KeyboardEvent('keypress', {
          ...options,
          keyCode: key.charCodeAt(0),
          which: key.charCodeAt(0),
          charCode: key.charCodeAt(0),
        }),
      );
      target.dispatchEvent(new KeyboardEvent('keyup', options));
    }
  }, text);
};

let server;
let origin;
let slowRequestStarted = false;
let slowRequestCanceled = false;
before(async () => {
  assert.ok(
    existsSync(join(workspace, '.zwip-e2e-fixture')),
    'Native acceptance only mutates a disposable, marked fixture.',
  );
  const database = new DatabaseSync(databasePath);
  database.exec(
    "CREATE TABLE IF NOT EXISTS people (id INTEGER PRIMARY KEY, name TEXT NOT NULL, score REAL, note TEXT); DELETE FROM people; INSERT INTO people VALUES (1, 'Original native name', 1.5, NULL), (2, 'Second row', 2, 'unchanged');",
  );
  database.close();
  server = createServer((request, response) => {
    if (request.url === '/slow') {
      slowRequestStarted = true;
      response.on('close', () => {
        if (!response.writableEnded) slowRequestCanceled = true;
      });
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json', 'x-native-fixture': 'verified' });
    response.end(
      JSON.stringify({
        marker: 'native-http-response',
        method: request.method,
        token: request.headers['x-native-token'],
      }),
    );
  });
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
});
afterEach(async function () {
  if (this.currentTest?.state === 'failed') {
    await screenshot(
      `failure-${this.currentTest.title.replace(/[^a-z0-9]+/gi, '-').slice(0, 90)}`,
    ).catch(() => {});
    const trace = await browser.execute(() => window.__nativeNavigationTrace ?? []).catch(() => []);
    if (trace.length) console.log('Native navigation IPC trace', trace);
  }
});
after(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
});

describe('native desktop workspace', () => {
  it('opens real files, saves Unicode, and preserves mirrored split-editor undo', async () => {
    const [window] = await browser.getWindowHandles();
    await browser.switchToWindow(window);
    await $('h1').waitForDisplayed();
    if ((await call('settings.get', { key: 'zwip.updates.lastSeen' })) !== updates[0].id) {
      const notes = $('dialog[aria-label="What’s new"]');
      await notes.waitForDisplayed();
      await notes.$('button=Got it').click();
      await browser.waitUntil(
        async () =>
          (await call('settings.get', { key: 'zwip.updates.lastSeen' })) === updates[0].id,
      );
    }
    await call('settings.set', { key: 'zwip.recentRoots', value: [workspace] });
    await browser.refresh();
    await $('.recent-projects button').waitForDisplayed();
    await $('.recent-projects button').click();
    await $('[aria-label="Filter project files"]').waitForDisplayed();
    await $('[role="treeitem"][title$="consumer.ts"]').click();
    const editor = $('[aria-label="Editor for consumer.ts"]');
    await editor.waitForDisplayed();
    await editor.click();
    await browser.keys(['Meta', 'End']);
    await browser.keys(['Enter']);
    // Printable browser.keys input is not inserted into contenteditable by this
    // embedded driver; addValue exercises its input path and CodeMirror state.
    await editor.addValue('// native edit λ 🚀 漢字\n');
    await browser.keys(['Meta', 's']);
    await browser.waitUntil(
      () =>
        readFileSync(join(workspace, 'consumer.ts'), 'utf8').includes('// native edit λ 🚀 漢字'),
      { timeout: 10000 },
    );
    await $('[aria-label="Split editor"]').click();
    assert.equal((await browser.$$('.cm-editor')).length, 2);
    const splitEditor = $('.editor-pane.secondary .cm-content');
    await splitEditor.addValue('// split undo marker');
    await browser.waitUntil(async () =>
      (await $('.editor-pane:not(.secondary) .cm-content').getText()).includes('split undo marker'),
    );
    await browser.keys(['Meta', 'z']);
    await browser.waitUntil(
      async () =>
        !(await $('.editor-pane:not(.secondary) .cm-content').getText()).includes(
          'split undo marker',
        ),
    );
    await browser.keys(['Meta', 's']);
    await $('[aria-label="Close split editor"]').click();
  });

  it('creates empty folders and reviews file move, trash, and recovery', async () => {
    await $('[aria-label="Project file actions"]').click();
    await $('button=New folder…').click();
    await $('[aria-label="Project relative path"]').setValue('createdfolder');
    await $('button=Create').click();
    await $('[role="treeitem"][title="createdfolder"]').waitForDisplayed();
    await $('[aria-label="Project file actions"]').click();
    await $('button=New file…').click();
    await $('[aria-label="Project relative path"]').setValue('createdfolder/draft.ts');
    await $('button=Create').click();
    const draft = $('[aria-label="Editor for draft.ts"]');
    await draft.waitForDisplayed();
    await draft.addValue('export const nativeFileAction = true;');
    await browser.keys(['Meta', 's']);
    await browser.waitUntil(() =>
      readFileSync(join(workspace, 'createdfolder/draft.ts'), 'utf8').includes('nativeFileAction'),
    );
    await $('[aria-label="Project file actions"]').click();
    await $('button=Rename or move file…').click();
    await $('[aria-label="Project relative path"]').setValue('createdfolder/moved.ts');
    await $('button=Review move').click();
    await $('button=Apply move').waitForDisplayed();
    assert.equal(existsSync(join(workspace, 'createdfolder/draft.ts')), true);
    assert.equal(existsSync(join(workspace, 'createdfolder/moved.ts')), false);
    await $('button=Apply move').click();
    await $('[aria-label="Editor for moved.ts"]').waitForDisplayed();
    assert.equal(existsSync(join(workspace, 'createdfolder/draft.ts')), false);
    await $('[aria-label="Project file actions"]').click();
    await $('button=Move file to IDE trash…').click();
    await $('button=Move to IDE trash').waitForDisplayed();
    await $('button=Move to IDE trash').click();
    await browser.waitUntil(() => !existsSync(join(workspace, 'createdfolder/moved.ts')));
    await browser.waitUntil(async () => !(await $('dialog').isExisting()));
    await $('[aria-label="Project file actions"]').click();
    await $('button=Recover trashed files…').click();
    await $('button=Restore').waitForDisplayed();
    await $('button=Restore').click();
    await browser.waitUntil(() => existsSync(join(workspace, 'createdfolder/moved.ts')));
    assert.match(
      readFileSync(join(workspace, 'createdfolder/moved.ts'), 'utf8'),
      /nativeFileAction/,
    );
    await browser.waitUntil(async () => await $('dialog').$('button=Close').isEnabled());
    await $('dialog').$('button=Close').click();
    await browser.waitUntil(async () => !(await $('dialog').isExisting()));
    await $('[aria-label="Editor for moved.ts"]').waitForDisplayed();
    await screenshot('file-actions');
  });

  it('installs a real language worker and resolves references through native IPC', async () => {
    await install('web');
    const snapshot = await call('workspace.refresh');
    const document = await call('document.open', { path: join(workspace, 'types.ts') });
    const result = await call('navigation.query', {
      query: {
        id: 'native-navigation',
        operation: 'references',
        path: document.path,
        position: { line: 1, character: 14 },
        documentRevision: document.revision,
        workspaceGeneration: snapshot.generation,
      },
    });
    assert.equal(result.state, 'complete');
    assert.ok(
      result.locations.some((location) => location.path.endsWith('consumer.ts')),
      JSON.stringify(result),
    );
    await $('[aria-label="Refresh project"]').click();
    await browser.waitUntil(
      async () => (await $('footer').getText()).includes('Project refreshed'),
      { timeout: 30000 },
    );
    await $('[role="treeitem"][title$="types.ts"]').click();
    await $('[aria-label="Editor for types.ts"]').waitForDisplayed();
    await waitForHighlightedToken('Editor for types.ts', 'interface');
    await screenshot('workspace');
  });

  it('writes an actual fixture file using keyboard input in the PTY terminal', async () => {
    await $('nav[aria-label="Tool windows"]').$('button=Terminal').click();
    const input = $('.terminal-host .xterm-helper-textarea');
    await input.waitForExist();
    await browser.execute(() =>
      document.querySelector('.terminal-host .xterm-helper-textarea').focus(),
    );
    await typeTerminal('echo native > terminalproof');
    await browser.keys('Enter');
    const proof = join(workspace, 'terminalproof');
    await browser.waitUntil(() => existsSync(proof) && readFileSync(proof, 'utf8') === 'native\n', {
      timeout: 15000,
      timeoutMsg: 'Terminal keystrokes did not reach the real shell.',
    });
    // Screen-reader output is exposed by xterm; the proof above does not rely on
    // canvas text or on directly invoking terminal.write from the test.
    await $('.terminal-host .xterm-accessibility').waitForExist();
    await screenshot('terminal');
    await $('button=Close session').click();
  });

  it('Cmd-clicks a usage to its declaration and a declaration to docked usages', async () => {
    await browser.execute(() => {
      const transport = window.__TAURI_INTERNALS__;
      const invoke = transport.invoke.bind(transport);
      window.__nativeNavigationTrace = [];
      transport.invoke = (command, args, ...rest) => {
        if (command !== 'ide_request') return invoke(command, args, ...rest);
        const entry = {
          method: args.method,
          operation: args.params?.query?.operation,
          id: args.params?.query?.id,
          state: 'pending',
        };
        window.__nativeNavigationTrace.push(entry);
        if (window.__nativeNavigationTrace.length > 60) window.__nativeNavigationTrace.shift();
        return invoke(command, args, ...rest).then(
          (result) => {
            entry.state = 'resolved';
            return result;
          },
          (error) => {
            entry.state = String(error);
            throw error;
          },
        );
      };
      return true;
    });
    await $('[role="treeitem"][title$="consumer.ts"]').click();
    await $('[aria-label="Editor for consumer.ts"]').waitForDisplayed();
    await cmdClickText('Editor for consumer.ts', 'Worker', 1);
    await $('[aria-label="Editor for types.ts"]').waitForDisplayed({ timeout: 20000 });
    await cmdClickText('Editor for types.ts', 'Worker');
    const results = $('.results-panel');
    await results.waitForDisplayed({ timeout: 20000 });
    await browser.waitUntil(async () => (await results.getText()).includes('consumer.ts'), {
      timeout: 20000,
    });
    assert.match(await results.getText(), /complete/);
    await screenshot('cmd-click-usages');
  });

  it('browses SQLite, reviews a row edit, and executes a query through the UI', async () => {
    await install('sql');
    await $('[aria-label="Database tools"]').click();
    await $('.connection-toolbar').$('button=New…').click();
    const dialog = $('dialog[aria-label="New database connection"]');
    await dialog.waitForDisplayed();
    await dialog.$('input[placeholder="Connection name"]').setValue('Native SQLite');
    await selectValue(
      'dialog[aria-label="New database connection"] .connection-form select',
      'sqlite',
    );
    await dialog.$('input[placeholder="/path/to/database.sqlite"]').setValue(databasePath);
    await dialog.$('button=Save connection').click();
    const tables = $('[aria-label="Database table"]');
    await tables.waitForDisplayed();
    await browser.waitUntil(
      async () => {
        const errors = await $('.database-panel').$$('[role="alert"]');
        if (errors.length) throw new Error(await errors[0].getText());
        return (await tables.getHTML()).includes('.people');
      },
      {
        timeout: 20000,
        timeoutMsg: 'SQLite schema did not appear in the native UI.',
      },
    );
    await selectValue('[aria-label="Database table"]', '.people');
    await $('[aria-label="Edit row 1 name"]').waitForDisplayed();
    await $('[aria-label="Edit row 1 name"]').click();
    const cell = $('dialog[aria-label="Edit name"]');
    await cell.$('textarea').setValue('Edited native name');
    await cell.$('button=Keep edit').click();
    const before = new DatabaseSync(databasePath);
    assert.equal(
      before.prepare('SELECT name FROM people WHERE id=1').get().name,
      'Original native name',
    );
    before.close();
    await $('button=Review and apply…').click();
    const review = $('dialog[aria-label="Apply database row edits"]');
    await review.waitForDisplayed();
    assert.match(await review.getText(), /Original native name/);
    assert.match(await review.getText(), /Edited native name/);
    await review.$('button=Apply changes').click();
    await browser.waitUntil(async () => !(await review.isExisting()));
    const after = new DatabaseSync(databasePath);
    assert.equal(
      after.prepare('SELECT name FROM people WHERE id=1').get().name,
      'Edited native name',
    );
    assert.equal(after.prepare('SELECT name FROM people WHERE id=2').get().name, 'Second row');
    after.close();
    const query = $('[aria-label="SQL query"]');
    await query.click();
    await query.addValue('SELECT name, score FROM people WHERE id = 1');
    await waitForHighlightedToken('SQL query', 'SELECT');
    // The embedded driver drops Meta on Enter. Verify execution through the
    // visible action; physical Cmd+Enter remains a separate native check.
    await $('.sql-browser').$('button=Execute').click();
    await browser.waitUntil(
      async () =>
        (await $('.sql-browser .response-tabs button[aria-pressed="true"]').getText()) ===
        'Query result',
      { timeout: 20000 },
    );
    await browser.waitUntil(async () =>
      (await $('.sql-browser .data-grid').getText()).includes('Edited native name'),
    );
    await screenshot('database');
    await $('[aria-label="Close Database tool"]').click();
  });

  it('sends HTTP environments and cancels an owned request when its panel closes', async () => {
    await install('http');
    await $('[aria-label="HTTP client"]').click();
    await $('[aria-label="HTTP request source"]').setValue(
      `GET ${origin}/inspect\nX-Native-Token: {{token}}`,
    );
    await $('.environment-editor summary').click();
    await $('[aria-label="HTTP environment variables"]').setValue('{"token":"fixture-only"}');
    await $('.http-panel').$('button=Send').click();
    await $('.http-response').waitForDisplayed({ timeout: 20000 });
    const response = JSON.parse(await $('.http-response').getText());
    assert.deepEqual(response, {
      marker: 'native-http-response',
      method: 'GET',
      token: 'fixture-only',
    });
    await $('.http-panel').$('button=Headers').click();
    assert.match(await $('.http-headers').getText(), /x-native-fixture/);
    await screenshot('http');
    await $('[aria-label="HTTP request source"]').setValue(`GET ${origin}/slow`);
    await $('.http-panel').$('button=Send').click();
    await browser.waitUntil(() => slowRequestStarted, { timeout: 10000 });
    await $('[aria-label="Close HTTP tool"]').click();
    await browser.waitUntil(() => slowRequestCanceled, {
      timeout: 10000,
      timeoutMsg: 'Closing HTTP did not abort the owned request.',
    });
  });

  it('runs Go tests and displays coverage from the installed Go package', async () => {
    await install('go');
    const source = await call('document.open', { path: join(workspace, 'main.go') });
    await call('navigation.query', {
      query: {
        id: 'go-readiness',
        operation: 'definition',
        path: source.path,
        position: { line: 4, character: 7 },
        documentRevision: source.revision,
        workspaceGeneration: source.workspaceGeneration,
      },
    });
    await browser.waitUntil(
      async () => {
        const state = await call('workspace.status');
        const contexts = state.contexts.filter((context) => context.language === 'go');
        return contexts.length > 0 && contexts.every((context) => context.state === 'ready');
      },
      { timeout: 60000, interval: 500, timeoutMsg: 'Go fixture context did not finish loading.' },
    );
    await $('[role="treeitem"][title$="main.go"]').click();
    await $('[aria-label="Editor for main.go"]').waitForDisplayed();
    await waitForHighlightedToken('Editor for main.go', 'package');
    await $('nav[aria-label="Tool windows"]').$('button=Go tools').click();
    const panel = $('section[aria-label="Go tools"]');
    await panel.waitForDisplayed();
    await panel.$('button=Test').click();
    await browser.waitUntil(
      async () =>
        (await panel.getText()).includes('TestGreeting') &&
        (await panel.$$('.test-pass')).length > 0,
      { timeout: 60000, timeoutMsg: 'Go test results did not reach the native UI.' },
    );
    await panel.$('button=Coverage').click();
    await panel.$('.go-coverage').waitForDisplayed();
    assert.match(await panel.$('.go-coverage').getText(), /statement coverage/);
    await $('.coverage-hit').waitForExist();
    await screenshot('go-tools');
    await panel.$('button=Close tools').click();
    await $('[role="treeitem"][title$="types.ts"]').click();
  });

  it('debugs Go with a breakpoint, stack, local variable, watch, and step', async () => {
    await $('[role="treeitem"][title$="main.go"]').click();
    const editor = $('[aria-label="Editor for main.go"]');
    await editor.waitForDisplayed();
    await editor.click();
    await browser.keys(['Meta', 'Home']);
    await browser.keys(Array.from({ length: 7 }, () => 'ArrowDown'));
    // Function-key modifiers are not retained by the embedded driver. Dispatch
    // the complete shortcut in the real CodeMirror input path.
    await browser.execute(() => {
      const target = document.activeElement;
      if (!target?.closest('.cm-content')) throw new Error('The source editor is not focused.');
      target.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'F8',
          code: 'F8',
          keyCode: 119,
          which: 119,
          metaKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await browser.waitUntil(
      async () => {
        const saved = await call('settings.get', { key: `zwip.${workspace}.breakpoints` });
        return saved?.[join(workspace, 'main.go')]?.includes(7);
      },
      { timeout: 10000, timeoutMsg: 'The editor breakpoint was not recorded on line 8.' },
    );
    await $('nav[aria-label="Tool windows"]').$('button=Go tools').click();
    const tools = $('section[aria-label="Go tools"]');
    await tools.$('button=Debug').click();
    const debuggerPanel = $('section[aria-label="Go debugger"]');
    await debuggerPanel.waitForDisplayed();
    await browser.waitUntil(
      async () => (await debuggerPanel.$('.debug-toolbar strong').getText()).startsWith('Paused'),
      {
        timeout: 60000,
        timeoutMsg: 'The real Delve debuggee did not stop at the editor breakpoint.',
      },
    );
    assert.match(await debuggerPanel.$('.debug-stack').getText(), /main\.main/);
    await browser.waitUntil(
      async () => {
        const variables = await debuggerPanel.$('.debug-variables').getText();
        return variables.includes('local') && variables.includes('"native"');
      },
      { timeout: 10000 },
    );
    await debuggerPanel.$('[aria-label="Watch expression"]').setValue('local');
    await debuggerPanel.$('button=Add').click();
    await browser.waitUntil(async () =>
      (await debuggerPanel.$('.debug-watches pre').getText()).includes('"native"'),
    );
    assert.match(await $('.debug-execution-line').getText(), /fmt\.Println\(local\)/);
    await screenshot('go-debugger');
    await debuggerPanel.$('button=Step over').click();
    await browser.waitUntil(
      async () =>
        (await debuggerPanel.$('.debug-toolbar strong').getText()).startsWith('Paused') &&
        (await $('.debug-execution-line').getText()).includes('local = "after"'),
      { timeout: 20000 },
    );
    await debuggerPanel.$('button=Continue').click();
    await browser.waitUntil(
      async () =>
        /Exited|Terminated/.test(await debuggerPanel.$('.debug-toolbar strong').getText()),
      { timeout: 20000 },
    );
    await debuggerPanel.$('.debug-output summary').click();
    const output = await debuggerPanel.$('.debug-output pre').getText();
    assert.match(output, /native/);
    assert.match(output, /after/);
    await debuggerPanel.$('button=Stop debugger').click();
    await browser.waitUntil(async () => !(await debuggerPanel.isExisting()));
    await tools.$('button=Close tools').click();
    await $('[role="treeitem"][title$="types.ts"]').click();
  });

  it('retains provider-ready build profiles and navigates tagged Go source in the selected context', async () => {
    await $('[role="treeitem"][title$="profile.go"]').click();
    await $('[aria-label="Editor for profile.go"]').waitForDisplayed();
    const selector = '[aria-label="Build context for profile.go"]';
    await $(selector).waitForDisplayed();
    assert.match(await $(selector).getHTML(), /native-profile/);
    assert.doesNotMatch(await $(selector).getHTML(), /tsconfig/);
    await selectValue(selector, 'go.mod#native-profile');
    await cmdClickText('Editor for profile.go', 'ProfileOnly', 1);
    await browser.waitUntil(
      async () => (await $('footer').getText()).includes('Declarations · complete'),
      { timeout: 20000 },
    );
    await cmdClickText('Editor for profile.go', 'ProfileOnly');
    await browser.waitUntil(
      async () => {
        const text = await $('.results-panel').getText();
        return text.includes('complete') && text.includes('profile.go');
      },
      { timeout: 20000 },
    );
    assert.equal(await $(selector).getValue(), 'go.mod#native-profile');
    await screenshot('go-profile');
    await selectValue(selector, '');
    await $('[role="treeitem"][title$="types.ts"]').click();
    assert.equal(await $('[aria-label="Build context for types.ts"]').isExisting(), false);
  });

  it('persists a custom shortcut and restores editor focus when a modal is dismissed', async () => {
    await $('footer').$('button=Settings').click();
    const settings = $('dialog[aria-label="Settings"]');
    const shortcut = settings.$('[aria-label="Shortcut for Go to file"]');
    await shortcut.click();
    await browser.keys(['Meta', 'Alt', 'p']);
    await settings.$('button=Save settings').click();
    await browser.waitUntil(async () => !(await settings.isExisting()));
    const saved = await call('settings.get', { key: 'shortcuts' });
    assert.equal(saved.files, 'Mod-Alt-p');
    await $('[aria-label="Editor for types.ts"]').click();
    await browser.keys(['Meta', 'Alt', 'p']);
    const picker = $('dialog[aria-label="Go to file"]');
    await picker.waitForDisplayed();
    assert.equal(
      await browser.execute(() => document.activeElement?.getAttribute('aria-label')),
      'Search project files',
    );
    await browser.keys('Escape');
    await browser.waitUntil(async () => !(await picker.isExisting()));
    assert.equal(await editorHasFocus(), true);
    // Keep the rest of this isolated qualification run on documented defaults.
    await $('footer').$('button=Settings').click();
    await $('button=Restore default shortcuts').click();
    await $('button=Save settings').click();
  });

  it('shows implementations in a keyboard-accessible chooser with a preview', async () => {
    await $('[role="treeitem"][title$="types.ts"]').click();
    const editor = $('[aria-label="Editor for types.ts"]');
    await editor.click();
    await browser.keys(['Meta', 'Home']);
    await browser.keys(Array.from({ length: 18 }, () => 'ArrowRight'));
    await browser.keys(['Meta', 'Alt', 'b']);
    const chooser = $('dialog[aria-label="Choose a target"]');
    await chooser.waitForDisplayed({ timeout: 30000 });
    assert.equal(
      await browser.execute(() => document.activeElement?.getAttribute('role')),
      'listbox',
    );
    assert.ok((await chooser.$$('[role="option"]')).length >= 2);
    await browser.keys('ArrowDown');
    assert.equal(await chooser.$('#target-1').getAttribute('aria-selected'), 'true');
    assert.ok((await chooser.$('.target-preview pre').getText()).length > 0);
    await screenshot('chooser');
    await browser.keys('Escape');
    await browser.waitUntil(async () => !(await chooser.isExisting()));
    assert.equal(await editorHasFocus(), true);
  });

  it('records clearly labeled fixture UI timing proxies', async () => {
    const competingIntelliJ = () => {
      try {
        return execFileSync('ps', ['-axo', 'comm'], { encoding: 'utf8' }).includes(
          '/IntelliJ IDEA.app/',
        );
      } catch {
        return null;
      }
    };
    const intellijRunningBefore = competingIntelliJ();
    const inputSamples = [];
    const tabSamples = [];
    const chooserSamples = [];
    await $('[role="tab"][title$="consumer.ts"]').click();
    const editor = $('[aria-label="Editor for consumer.ts"]');
    await editor.click();
    await browser.keys(['Meta', 'End']);
    await editor.addValue('\n// native timing samples: ');
    for (let sample = 0; sample < 25; sample++) {
      const result = await browser.executeAsync((done) => {
        const target = document.querySelector('[aria-label="Editor for consumer.ts"]');
        target.focus();
        const before = target.textContent;
        const start = performance.now();
        const inserted = document.execCommand('insertText', false, 'x');
        requestAnimationFrame(() =>
          requestAnimationFrame(() =>
            done({
              elapsedMs: performance.now() - start,
              changed: inserted && target.textContent !== before,
            }),
          ),
        );
      });
      assert.equal(result.changed, true, 'The timing sample must actually edit the real buffer.');
      if (sample >= 5) inputSamples.push(result.elapsedMs);
    }
    await browser.keys(['Meta', 's']);
    for (let sample = 0; sample < 24; sample++) {
      const file = sample % 2 ? 'consumer.ts' : 'types.ts';
      const result = await browser.executeAsync((file, done) => {
        const tab = document.querySelector(`[role="tab"][title$="/${file}"]`);
        if (!tab) return done({ error: `Missing warm tab ${file}` });
        const start = performance.now();
        const timeout = setTimeout(() => finish({ error: 'Warm tab did not render.' }), 5000);
        let finished = false;
        const observer = new MutationObserver(check);
        observer.observe(document.body, { childList: true, subtree: true, attributes: true });
        function finish(result) {
          if (finished) return;
          finished = true;
          observer.disconnect();
          clearTimeout(timeout);
          done(result);
        }
        function check() {
          if (finished || !document.querySelector(`[aria-label="Editor for ${file}"]`)) return;
          observer.disconnect();
          requestAnimationFrame(() =>
            requestAnimationFrame(() => finish({ elapsedMs: performance.now() - start })),
          );
        }
        tab.click();
        check();
      }, file);
      assert.equal(result.error, undefined);
      if (sample >= 4) tabSamples.push(result.elapsedMs);
    }
    await $('[role="tab"][title$="types.ts"]').click();
    await $('[aria-label="Editor for types.ts"]').click();
    await browser.keys(['Meta', 'Home']);
    await browser.keys(Array.from({ length: 18 }, () => 'ArrowRight'));
    for (let sample = 0; sample < 12; sample++) {
      // Deliver complete key events outside the timed interval. The embedded
      // driver's modifier bookkeeping can retain a previous Alt key.
      await browser.execute(() => {
        const target = document.querySelector('[aria-label="Editor for types.ts"]');
        target.focus();
        const key = (key, code, keyCode, metaKey = false) => {
          const options = {
            key,
            code,
            keyCode,
            which: keyCode,
            metaKey,
            bubbles: true,
            cancelable: true,
          };
          target.dispatchEvent(new KeyboardEvent('keydown', options));
          target.dispatchEvent(new KeyboardEvent('keyup', options));
        };
        key('Home', 'Home', 36, true);
        for (let n = 0; n < 19; n++) key('ArrowRight', 'ArrowRight', 39);
      });
      await browser.waitUntil(async () => (await $('footer').getText()).includes('1:20'));
      const result = await browser.executeAsync((done) => {
        const target = document.activeElement;
        const start = performance.now();
        const timeout = setTimeout(
          () => finish({ error: 'Implementation chooser did not render.' }),
          10000,
        );
        let finished = false;
        const observer = new MutationObserver(check);
        observer.observe(document.body, { childList: true, subtree: true, attributes: true });
        function finish(result) {
          if (finished) return;
          finished = true;
          observer.disconnect();
          clearTimeout(timeout);
          done(result);
        }
        function check() {
          const chooser = document.querySelector('dialog[aria-label="Choose a target"][open]');
          if (finished || !chooser || chooser.querySelectorAll('[role="option"]').length < 2)
            return;
          observer.disconnect();
          requestAnimationFrame(() =>
            requestAnimationFrame(() => finish({ elapsedMs: performance.now() - start })),
          );
        }
        target.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'b',
            code: 'KeyB',
            keyCode: 66,
            which: 66,
            metaKey: true,
            altKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
        check();
      });
      assert.equal(result.error, undefined);
      if (sample >= 2) chooserSamples.push(result.elapsedMs);
      await browser.keys('Escape');
      await browser.waitUntil(
        async () => !(await $('dialog[aria-label="Choose a target"]').isExisting()),
      );
    }
    const distribution = (samples) => {
      const sorted = [...samples].sort((a, b) => a - b);
      const percentile = (p) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
      return {
        count: samples.length,
        samplesMs: samples,
        p50Ms: percentile(0.5),
        p95Ms: percentile(0.95),
        p99Ms: percentile(0.99),
      };
    };
    mkdirSync('artifacts', { recursive: true });
    writeFileSync(
      resolve('artifacts/native-ui-timings.json'),
      JSON.stringify(
        {
          recordedAt: new Date().toISOString(),
          build: 'debug application with embedded WebDriver automation',
          binaryModifiedAt: statSync(resolve('target/debug/zwip')).mtime.toISOString(),
          machine: {
            platform: process.platform,
            architecture: arch(),
            osRelease: release(),
            cpu: cpus()[0]?.model,
          },
          workspace: 'Disposable tiny native acceptance fixture; not goserving',
          competingIntelliJProcess: { before: intellijRunningBefore, after: competingIntelliJ() },
          measurement:
            'Renderer performance.now from synthesized DOM action to two requestAnimationFrame callbacks after expected DOM state.',
          limitations: [
            'Double-RAF is a paint-opportunity proxy, not measured physical input-to-photon latency.',
            'Synthetic DOM input, debug build, tiny warm fixture, and active automation are not production or large-workspace qualification.',
            'No target pass/fail or comparative resource result is inferred.',
            'A competing IntelliJ process, when recorded above, further prevents isolated latency conclusions.',
          ],
          inputDoubleRaf: distribution(inputSamples),
          warmTabDoubleRaf: distribution(tabSamples),
          warmImplementationChooserDoubleRaf: distribution(chooserSamples),
        },
        null,
        2,
      ),
    );
  });

  it('saves a named run configuration and executes it from the topbar after restart', async () => {
    const proof = join(workspace, 'run-config-proof');
    await $('[aria-label="Run selected configuration"]').click();
    await $('[aria-label="Run configuration name"]').setValue('Native proof task');
    await $('[aria-label="Command to run"]').setValue(
      "printf 'native-run-config\\n' > run-config-proof && printf 'run-config-output\\n'",
    );
    await $('[aria-label="Run working directory"]').setValue('.');
    await $('button=Save configuration').click();
    await browser.waitUntil(
      () =>
        browser.execute(() =>
          document
            .querySelector('[aria-label="Run configuration"]')
            ?.selectedOptions[0]?.textContent.includes('Native proof task'),
        ),
      { timeout: 10000 },
    );
    const selectedId = await $('[aria-label="Run configuration"]').getValue();
    const saved = await call('settings.get', { key: `zwip.${workspace}.runConfigurations` });
    assert.equal(saved.selectedId, selectedId);
    assert.equal(
      saved.configurations.find((configuration) => configuration.id === selectedId).name,
      'Native proof task',
    );
    await $('[aria-label="Run selected configuration"]').click();
    await browser.waitUntil(
      () => existsSync(proof) && readFileSync(proof, 'utf8') === 'native-run-config\n',
      { timeout: 15000 },
    );
    await browser.waitUntil(
      async () => (await $('[aria-label="Task output"]').getText()).includes('run-config-output'),
      { timeout: 10000 },
    );
    await screenshot('run-configuration');
    await browser.refresh();
    await $('.recent-projects button').waitForDisplayed();
    await $('.recent-projects button').click();
    await browser.waitUntil(
      async () => (await $('[aria-label="Run configuration"]').getValue()) === selectedId,
      { timeout: 15000 },
    );
    unlinkSync(proof);
    await $('[aria-label="Run selected configuration"]').click();
    await browser.waitUntil(
      () => existsSync(proof) && readFileSync(proof, 'utf8') === 'native-run-config\n',
      { timeout: 15000 },
    );
  });
});
