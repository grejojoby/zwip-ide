import type { IntelliJKeymap, IntelliJKeymapAction } from './intellij-import-contracts';
import {
  canonicalShortcut,
  shortcutConflicts,
  type ShortcutAction,
  type Shortcuts,
} from './shortcuts';

const supportedActions: Record<string, ShortcutAction> = {
  SaveAll: 'save',
  GotoFile: 'files',
  GotoSymbol: 'symbols',
  GotoAction: 'actions',
  FindInPath: 'search',
  Back: 'back',
  Forward: 'forward',
  GotoDeclaration: 'declaration',
  GotoImplementation: 'implementations',
  FindUsages: 'usages',
  ReformatCode: 'format',
  RenameElement: 'rename',
  ShowIntentionActions: 'fixes',
  CopyReference: 'copyReference',
  NewScratchFile: 'scratch',
  ToggleLineBreakpoint: 'breakpoint',
};

// Resolved keyboard defaults for these 16 actions, verified read-only in IU223.8836.41:
// app.jar keymaps/Mac OS X 10.5+.xml SHA256 af6d1085602abde2b77c86251f851e94e08516a24a682c8b9f2a99dcf7b4a111
// app.jar keymaps/$default.xml SHA256 a0cb43d8100cc8cd9e1a8e7f1bfe12ff4010e2c151e8ea7725be91d9c814a03b
// MacOSDefaultKeymap converts Ctrl/Meta for inherited stock shortcuts, not custom overrides:
// https://github.com/JetBrains/intellij-community/blob/master/platform/platform-impl/src/com/intellij/openapi/keymap/impl/MacOSDefaultKeymap.kt
// Store resolved values so this special stock inheritance never rewrites custom Control bindings.
const stockKeyboardBindings: [string, string[]][] = [
  ['SaveAll', ['meta S']],
  ['GotoFile', ['meta shift O']],
  ['GotoSymbol', ['meta alt O']],
  ['GotoAction', ['meta shift A']],
  ['FindInPath', ['meta shift F']],
  ['Back', ['meta OPEN_BRACKET', 'meta alt LEFT']],
  ['Forward', ['meta CLOSE_BRACKET', 'meta alt RIGHT']],
  ['GotoDeclaration', ['meta B']],
  ['GotoImplementation', ['meta alt B']],
  ['FindUsages', ['alt F7']],
  ['ReformatCode', ['meta alt L']],
  ['RenameElement', ['shift F6']],
  ['ShowIntentionActions', ['alt ENTER']],
  // $default.xml "control alt shift C", converted to Meta by the macOS stock keymap.
  ['CopyReference', ['meta alt shift C']],
  // Mac OS X 10.5+.xml overrides NewScratchFile to "meta shift N".
  ['NewScratchFile', ['meta shift N']],
  ['ToggleLineBreakpoint', ['meta F8']],
];
const macDefaults: IntelliJKeymapAction[] = stockKeyboardBindings.map(([id, strokes]) => ({
  id,
  shortcuts: strokes.map((first) => ({ first })),
  hasMouse: ['Back', 'Forward', 'GotoDeclaration', 'GotoImplementation'].includes(id),
}));

const swingKeys: Record<string, string> = {
  ENTER: 'Enter',
  ESCAPE: 'Escape',
  TAB: 'Tab',
  SPACE: 'Space',
  BACK_SPACE: 'Backspace',
  DELETE: 'Delete',
  INSERT: 'Insert',
  HOME: 'Home',
  END: 'End',
  PAGE_UP: 'PageUp',
  PAGE_DOWN: 'PageDown',
  UP: 'ArrowUp',
  DOWN: 'ArrowDown',
  LEFT: 'ArrowLeft',
  RIGHT: 'ArrowRight',
  OPEN_BRACKET: '[',
  CLOSE_BRACKET: ']',
  SLASH: '/',
  BACK_SLASH: '\\',
  SEMICOLON: ';',
  QUOTE: "'",
  BACK_QUOTE: '`',
  COMMA: ',',
  PERIOD: '.',
  MINUS: '-',
  EQUALS: '=',
};
const swingModifiers: Record<string, string> = {
  meta: 'Mod',
  ctrl: 'Ctrl',
  control: 'Ctrl',
  alt: 'Alt',
  shift: 'Shift',
};

function translateStroke(stroke: string): string | null {
  const tokens = stroke.trim().split(/\s+/);
  const keyName = tokens.pop()?.toUpperCase() ?? '';
  if (tokens.at(-1)?.toLowerCase() === 'pressed') tokens.pop();
  const modifiers = tokens.map((token) => swingModifiers[token.toLowerCase()]);
  if (modifiers.some((modifier) => !modifier)) return null;
  const key =
    swingKeys[keyName] ?? (/^[A-Z0-9]$|^F(?:[1-9]|1\d|2[0-4])$/.test(keyName) ? keyName : null);
  return key === null ? null : canonicalShortcut([...modifiers, key].join('-'));
}

export interface IntelliJKeymapPreview {
  shortcuts: Shortcuts;
  changes: { action: ShortcutAction; from: string; to: string; sourceAction: string }[];
  notices: string[];
  conflicts: string[];
  complete: boolean;
}

/** Translate effective overrides only; unsupported child overrides must not resurrect parent bindings. */
export function previewIntelliJKeymap(
  keymaps: IntelliJKeymap[],
  name: string,
  current: Shortcuts,
): IntelliJKeymapPreview {
  const shortcuts = { ...current };
  const notices: string[] = [];
  const changes: IntelliJKeymapPreview['changes'] = [];
  const effective = new Map<string, IntelliJKeymapAction | null>();
  const visiting = new Set<string>();
  let complete = true;
  const incomplete = (message: string) => {
    notices.push(message);
    complete = false;
  };

  function inherit(selected: string): void {
    if (visiting.has(selected)) {
      incomplete(
        `Keymap inheritance cycle at "${selected}"; missing ancestor bindings are left unchanged.`,
      );
      return;
    }
    const matches = keymaps.filter((keymap) => keymap.name === selected);
    if (matches.length > 1) {
      incomplete(
        `Keymap "${selected}" is ambiguous (${matches.length} entries); its bindings are left unchanged.`,
      );
      return;
    }
    const keymap = matches[0];
    if (!keymap) {
      if (/^_?Mac OS X ?10\.5\+$/.test(selected)) {
        for (const action of macDefaults) effective.set(action.id, action);
      } else {
        incomplete(
          `Keymap "${selected}" was not found; missing ancestor bindings are left unchanged.`,
        );
      }
      return;
    }
    visiting.add(selected);
    if (keymap.parent) inherit(keymap.parent);
    const seen = new Set<string>();
    for (const action of keymap.actions) {
      if (seen.has(action.id)) {
        incomplete(
          `${action.id} has duplicate entries in "${selected}"; its binding is left unchanged.`,
        );
        effective.set(action.id, null);
      } else {
        seen.add(action.id);
        effective.set(action.id, action);
      }
    }
    visiting.delete(selected);
  }
  inherit(name);

  for (const [sourceAction, entry] of effective) {
    if (!entry) continue;
    const action = Object.hasOwn(supportedActions, sourceAction)
      ? supportedActions[sourceAction]
      : undefined;
    if (!action) {
      incomplete(
        `${sourceAction} is an unsupported IntelliJ action; no Zwip shortcut was changed.`,
      );
      continue;
    }
    if (entry.hasMouse)
      incomplete(`${sourceAction}: mouse shortcuts are unsupported and were not imported.`);
    const candidates: string[] = [];
    for (const stroke of entry.shortcuts) {
      if (stroke.second !== undefined) {
        incomplete(
          `${sourceAction}: chord "${stroke.first}, ${stroke.second}" is unsupported and was not imported.`,
        );
        continue;
      }
      const translated = translateStroke(stroke.first);
      if (translated === null) {
        incomplete(`${sourceAction}: unsupported keystroke "${stroke.first}" was not imported.`);
      } else if (/^Alt-(?:Shift-)?[^-]$|^Alt-(?:Shift-)?-$/.test(translated)) {
        // CodeMirror intentionally preserves macOS Option text input rather than matching its
        // unmodified physical key. Do not import a shortcut that only the global handler runs.
        incomplete(
          `${sourceAction}: Option-only printable shortcut "${stroke.first}" cannot reliably run in the editor and was not imported.`,
        );
      } else {
        candidates.push(translated);
      }
    }
    const binding =
      candidates[0] ?? (entry.shortcuts.length === 0 && !entry.hasMouse ? '' : undefined);
    if (binding === undefined) continue;
    if (entry.shortcuts.length > 1) {
      incomplete(
        `${sourceAction}: alternate bindings cannot be represented; selected "${binding}" and omitted the others.`,
      );
    }
    if (sourceAction === 'SaveAll' && binding !== '') {
      incomplete(
        'SaveAll maps to Zwip Save file (the active document), not IntelliJ Save All Documents.',
      );
    }
    if (canonicalShortcut(current[action]) === binding) continue;
    shortcuts[action] = binding;
    changes.push({ action, from: current[action], to: binding, sourceAction });
  }
  const conflicts = shortcutConflicts(shortcuts);
  return { shortcuts, changes, notices, conflicts, complete: complete && conflicts.length === 0 };
}
