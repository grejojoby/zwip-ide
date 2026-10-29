import { describe, expect, it, vi } from 'vitest';
import {
  canonicalShortcut,
  defaultShortcuts,
  doubleTapRecognizer,
  matchesShortcut,
  normalizedShortcuts,
  shortcutConflicts,
  shortcutFromEvent,
  shortcutLabel,
  validShortcut,
} from './shortcuts';
describe('macOS shortcuts', () => {
  it('matches physical letter codes even when Option produces an alternate character', () => {
    const event = {
      key: '∫',
      code: 'KeyB',
      metaKey: true,
      altKey: true,
      ctrlKey: false,
      shiftKey: false,
    } as KeyboardEvent;
    expect(shortcutFromEvent(event)).toBe('Mod-Alt-b');
    expect(matchesShortcut(event, defaultShortcuts.implementations)).toBe(true);
    expect(matchesShortcut(event, defaultShortcuts.declaration)).toBe(false);
  });
  it('rejects duplicate bindings and preserves explicitly unassigned keys', () => {
    const shortcuts = normalizedShortcuts({ files: '', symbols: defaultShortcuts.save });
    expect(shortcuts.files).toBe('');
    expect(shortcutConflicts(shortcuts)).toHaveLength(1);
  });
  it('ignores modifier-only recording events', () => {
    expect(
      shortcutFromEvent({
        key: 'Meta',
        code: 'MetaLeft',
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
      }),
    ).toBeNull();
  });
  it('canonicalizes Meta aliases, modifier order, named keys and literal Space', () => {
    expect(normalizedShortcuts({ files: 'Shift-Meta-P', symbols: 'ctrl- ' })).toMatchObject({
      files: 'Mod-Shift-p',
      symbols: 'Ctrl-Space',
    });
    expect(canonicalShortcut('Shift-Alt-Ctrl-Meta-Enter')).toBe('Mod-Ctrl-Alt-Shift-Enter');
    expect(canonicalShortcut('Meta-Mod-b')).toBeNull();
    expect(validShortcut('Ctrl-Alt-F25')).toBe(false);
    expect(validShortcut('Ctrl-k Ctrl-c')).toBe(false);
    expect(validShortcut('p')).toBe(false);
    expect(shortcutConflicts({ ...defaultShortcuts, files: 'Shift-Meta-A' })).toHaveLength(1);
  });
  it('matches reordered Meta bindings while preserving Control as a distinct modifier', () => {
    const event = {
      key: 'P',
      code: 'KeyP',
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: true,
    } as KeyboardEvent;
    expect(matchesShortcut(event, 'Shift-Meta-p')).toBe(true);
    expect(matchesShortcut(event, 'Ctrl-Shift-p')).toBe(false);
    expect(
      matchesShortcut({ ...event, key: ' ', code: 'Space', shiftKey: false }, 'Mod-Space'),
    ).toBe(true);
  });
  it.each([
    ['Slash', '?', '/', true],
    ['Period', '>', '.', true],
    ['Comma', '<', ',', true],
    ['BracketLeft', '{', '[', true],
    ['Minus', '-', '-', false],
  ])('records and matches physical punctuation %s', (code, key, physical, shiftKey) => {
    const event = {
      code,
      key,
      shiftKey,
      metaKey: true,
      ctrlKey: false,
      altKey: false,
    } as KeyboardEvent;
    const shortcut = `Mod-${shiftKey ? 'Shift-' : ''}${physical}`;
    expect(shortcutFromEvent(event)).toBe(shortcut);
    expect(validShortcut(shortcut)).toBe(true);
    expect(matchesShortcut(event, shortcut)).toBe(true);
  });
  it('runs imported punctuation and Space through CodeMirror’s actual macOS key handler', async () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel', userAgent: 'Macintosh', vendor: 'Apple' });
    try {
      const { EditorState } = await import('@codemirror/state');
      const { keymap, runScopeHandlers } = await import('@codemirror/view');
      for (const [binding, key, code, keyCode, shiftKey] of [
        ['Mod-Shift-/', '?', 'Slash', 191, true],
        ['Mod--', '-', 'Minus', 189, false],
        ['Mod-Space', ' ', 'Space', 32, false],
      ] as const) {
        const run = vi.fn(() => true);
        const state = EditorState.create({ extensions: [keymap.of([{ key: binding, run }])] });
        const view = { state } as import('@codemirror/view').EditorView;
        const event = {
          key,
          code,
          keyCode,
          shiftKey,
          metaKey: true,
          ctrlKey: false,
          altKey: false,
        } as KeyboardEvent;
        expect(runScopeHandlers(view, event, 'editor')).toBe(true);
        expect(run).toHaveBeenCalledOnce();
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('recognizes a double-tapped lone modifier and labels it', () => {
    const tap = doubleTapRecognizer();
    const shift = (type: 'keydown' | 'keyup', timeStamp: number, extra = {}) =>
      tap({
        type,
        key: 'Shift',
        repeat: false,
        timeStamp,
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: type === 'keydown',
        ...extra,
      });
    expect(shift('keydown', 0)).toBeNull();
    expect(shift('keyup', 50)).toBeNull();
    expect(shift('keydown', 150)).toBeNull();
    expect(shift('keyup', 200)).toBe('Shift Shift');
    // Too slow, or another key in between, does not count.
    shift('keydown', 1000);
    shift('keyup', 1050);
    shift('keydown', 1600);
    expect(shift('keyup', 1650)).toBeNull();
    shift('keydown', 3000);
    shift('keyup', 3050);
    tap({
      type: 'keydown',
      key: 'a',
      repeat: false,
      timeStamp: 3100,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
    });
    shift('keydown', 3150);
    expect(shift('keyup', 3200)).toBeNull();
    expect(canonicalShortcut('shift shift')).toBe('Shift Shift');
    expect(shortcutLabel('Shift Shift')).toBe('⇧⇧');
    expect(normalizedShortcuts({ files: 'Shift Shift' }).files).toBe('Shift Shift');
  });
});

it('defaults Push to Cmd+Shift+K and fills it into older shortcut settings', () => {
  expect(defaultShortcuts.push).toBe('Mod-Shift-k');
  expect(normalizedShortcuts({ save: 'Mod-s' }).push).toBe('Mod-Shift-k');
  expect(
    matchesShortcut(
      {
        key: 'K',
        code: 'KeyK',
        metaKey: true,
        shiftKey: true,
        ctrlKey: false,
        altKey: false,
      } as KeyboardEvent,
      defaultShortcuts.push,
    ),
  ).toBe(true);
});

it('defaults Update Project to Cmd+T and preserves older shortcut settings', () => {
  expect(defaultShortcuts.updateProject).toBe('Mod-t');
  expect(normalizedShortcuts({ save: 'Mod-s' }).updateProject).toBe('Mod-t');
  expect(
    matchesShortcut(
      {
        key: 't',
        code: 'KeyT',
        metaKey: true,
        shiftKey: false,
        ctrlKey: false,
        altKey: false,
      } as KeyboardEvent,
      defaultShortcuts.updateProject,
    ),
  ).toBe(true);
});
