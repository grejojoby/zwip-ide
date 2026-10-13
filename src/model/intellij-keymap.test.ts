import { describe, expect, it } from 'vitest';
import type { IntelliJKeymap, IntelliJKeymapAction } from './intellij-import-contracts';
import { previewIntelliJKeymap } from './intellij-keymap';
import { defaultShortcuts } from './shortcuts';

const action = (id: string, ...first: string[]): IntelliJKeymapAction => ({
  id,
  shortcuts: first.map((stroke) => ({ first: stroke })),
  hasMouse: false,
});
const preview = (actions: IntelliJKeymapAction[]) =>
  previewIntelliJKeymap([{ name: 'Custom', actions }], 'Custom', defaultShortcuts);

describe('IntelliJ keymap preview', () => {
  it('resolves verified stock macOS defaults without converting custom Control to Command', () => {
    const current = { ...defaultShortcuts, files: 'Ctrl-p', rename: '' };
    const result = previewIntelliJKeymap(
      [
        {
          name: 'Custom',
          parent: '_Mac OS X10.5+',
          actions: [action('GotoFile', 'ctrl pressed P')],
        },
      ],
      'Custom',
      current,
    );
    expect(result.shortcuts).toEqual({ ...defaultShortcuts, files: 'Ctrl-p' });
    expect(result.changes).toEqual([
      { action: 'rename', from: '', to: 'Shift-F6', sourceAction: 'RenameElement' },
    ]);
    expect(result.notices.join('\n')).toMatch(/SaveAll.*Save file/);
    expect(result.notices.join('\n')).toMatch(/Back.*alternate/);
    expect(result.complete).toBe(false);
  });

  it('supports selecting all 14 known stock bindings directly', () => {
    // Git branches has no verified IntelliJ mapping, so the importer leaves it untouched.
    const empty = {
      ...Object.fromEntries(Object.keys(defaultShortcuts).map((action) => [action, ''])),
      branches: defaultShortcuts.branches,
    } as typeof defaultShortcuts;
    const result = previewIntelliJKeymap([], 'Mac OS X 10.5+', empty);
    expect(result.shortcuts).toEqual(defaultShortcuts);
    expect(result.changes).toHaveLength(14);
    expect(result.changes).toContainEqual({
      action: 'files',
      from: '',
      to: 'Mod-Shift-o',
      sourceAction: 'GotoFile',
    });
  });

  it('inherits custom keymaps, applies removals, and leaves unmapped current settings intact', () => {
    const maps: IntelliJKeymap[] = [
      {
        name: 'Base',
        actions: [action('GotoFile', 'meta P'), action('RenameElement', 'shift F2')],
      },
      {
        name: 'Custom',
        parent: 'Base',
        actions: [action('GotoFile'), action('FindUsages', 'ctrl alt F9')],
      },
    ];
    const result = previewIntelliJKeymap(maps, 'Custom', defaultShortcuts);
    expect(result.shortcuts).toEqual({
      ...defaultShortcuts,
      files: '',
      rename: 'Shift-F2',
      usages: 'Ctrl-Alt-F9',
    });
    expect(result.complete).toBe(true);
    expect(result.changes).toHaveLength(3);
    expect(defaultShortcuts.files).toBe('Mod-Shift-o');
  });

  it('reports missing and cyclic ancestry while retaining usable child overrides', () => {
    const missing = previewIntelliJKeymap(
      [{ name: 'Custom', parent: 'Missing', actions: [action('GotoFile', 'meta P')] }],
      'Custom',
      defaultShortcuts,
    );
    expect(missing.complete).toBe(false);
    expect(missing.shortcuts.files).toBe('Mod-p');
    expect(missing.shortcuts.rename).toBe(defaultShortcuts.rename);
    expect(missing.notices.join('\n')).toMatch(/Missing.*not found/);
    const cyclic = previewIntelliJKeymap(
      [
        { name: 'A', parent: 'B', actions: [action('GotoFile', 'meta P')] },
        { name: 'B', parent: 'A', actions: [action('RenameElement', 'shift F2')] },
      ],
      'A',
      defaultShortcuts,
    );
    expect(cyclic.complete).toBe(false);
    expect(cyclic.notices.join('\n')).toMatch(/cycle/i);
    expect(cyclic.shortcuts.files).toBe('Mod-p');
    expect(cyclic.shortcuts.rename).toBe('Shift-F2');
  });

  it('prefers a representable alternate and reports every discarded chord, malformed key, and mouse gesture', () => {
    const result = preview([
      {
        id: 'GotoFile',
        hasMouse: true,
        shortcuts: [
          { first: 'ctrl K', second: 'ctrl P' },
          { first: 'meta typed P' },
          { first: 'shift meta pressed P' },
          { first: 'meta O' },
        ],
      },
    ]);
    expect(result.shortcuts.files).toBe('Mod-Shift-p');
    expect(result.complete).toBe(false);
    const notices = result.notices.join('\n');
    expect(notices).toMatch(/chord.*ctrl K.*ctrl P/i);
    expect(notices).toMatch(/unsupported.*meta typed P/i);
    expect(notices).toMatch(/mouse/i);
    expect(notices).toMatch(/alternate.*Mod-Shift-p/i);
  });

  it('does not mistake mouse-only or unsupported child bindings for an explicit clear or parent fallback', () => {
    const result = previewIntelliJKeymap(
      [
        { name: 'Base', actions: [action('GotoFile', 'meta P'), action('GotoSymbol', 'meta Y')] },
        {
          name: 'Custom',
          parent: 'Base',
          actions: [
            { id: 'GotoFile', hasMouse: false, shortcuts: [{ first: 'ctrl K', second: 'ctrl P' }] },
            { id: 'GotoSymbol', hasMouse: true, shortcuts: [] },
          ],
        },
      ],
      'Custom',
      defaultShortcuts,
    );
    expect(result.shortcuts).toEqual(defaultShortcuts);
    expect(result.changes).toEqual([]);
    expect(result.complete).toBe(false);
  });

  it('normalizes Swing punctuation, function keys, modifier order, and Space', () => {
    const result = preview([
      action('GotoFile', 'shift meta pressed SLASH'),
      action('GotoSymbol', 'meta MINUS'),
      action('Back', 'shift meta OPEN_BRACKET'),
      action('Forward', 'control SPACE'),
      action('FindUsages', 'alt f12'),
      action('ReformatCode', 'shift control alt PERIOD'),
    ]);
    expect(result.shortcuts.files).toBe('Mod-Shift-/');
    expect(result.shortcuts.symbols).toBe('Mod--');
    expect(result.shortcuts.back).toBe('Mod-Shift-[');
    expect(result.shortcuts.forward).toBe('Ctrl-Space');
    expect(result.shortcuts.usages).toBe('Alt-F12');
    expect(result.shortcuts.format).toBe('Ctrl-Alt-Shift-.');
    expect(result.complete).toBe(true);
  });

  it('reports unknown actions, malformed strokes, and conflicts without discarding usable changes', () => {
    const result = preview([
      action('UnknownPluginAction', 'meta X'),
      action('GotoSymbol', 'meta meta Y'),
      action('GotoFile', 'meta S'),
      action('RenameElement', 'shift F99'),
    ]);
    expect(result.shortcuts.files).toBe('Mod-s');
    expect(result.shortcuts.symbols).toBe(defaultShortcuts.symbols);
    expect(result.shortcuts.rename).toBe(defaultShortcuts.rename);
    expect(result.conflicts).toHaveLength(1);
    expect(result.notices.join('\n')).toMatch(/UnknownPluginAction.*unsupported/);
    expect(result.complete).toBe(false);
  });

  it('recognizes equivalent current bindings without cosmetic changes', () => {
    const current = { ...defaultShortcuts, files: 'Shift-Meta-p' };
    const result = previewIntelliJKeymap(
      [{ name: 'Custom', actions: [action('GotoFile', 'meta shift P')] }],
      'Custom',
      current,
    );
    expect(result.shortcuts.files).toBe('Shift-Meta-p');
    expect(result.changes).toEqual([]);
    expect(result.complete).toBe(true);
  });

  it('does not guess when selected keymaps or effective action entries are ambiguous', () => {
    const duplicate = previewIntelliJKeymap(
      [
        { name: 'Custom', actions: [action('GotoFile', 'meta P')] },
        { name: 'Custom', actions: [action('GotoFile', 'meta O')] },
      ],
      'Custom',
      defaultShortcuts,
    );
    expect(duplicate.shortcuts).toEqual(defaultShortcuts);
    expect(duplicate.complete).toBe(false);
    expect(duplicate.notices.join('\n')).toMatch(/ambiguous/i);
    const result = preview([action('GotoFile', 'meta P'), action('GotoFile', 'meta O')]);
    expect(result.shortcuts.files).toBe(defaultShortcuts.files);
    expect(result.notices.join('\n')).toMatch(/GotoFile.*duplicate/i);
  });

  it('reports Option-only printable bindings that CodeMirror reserves for text input', () => {
    const result = preview([
      action('GotoFile', 'alt N'),
      action('GotoSymbol', 'alt shift SLASH'),
      action('Back', 'alt MINUS'),
      action('FindUsages', 'alt F8'),
    ]);
    expect(result.shortcuts.files).toBe(defaultShortcuts.files);
    expect(result.shortcuts.symbols).toBe(defaultShortcuts.symbols);
    expect(result.shortcuts.back).toBe(defaultShortcuts.back);
    expect(result.shortcuts.usages).toBe('Alt-F8');
    expect(result.notices.filter((notice) => notice.includes('Option-only'))).toHaveLength(3);
    expect(result.complete).toBe(false);
  });
});
