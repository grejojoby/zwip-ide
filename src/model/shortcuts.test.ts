import { describe, expect, it, vi } from 'vitest';
import {
  canonicalShortcut,
  defaultShortcuts,
  matchesShortcut,
  normalizedShortcuts,
  shortcutConflicts,
  shortcutFromEvent,
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
});
