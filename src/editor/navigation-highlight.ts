import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';

/** Marks a navigation target: its line, and the symbol when the range is not empty. */
export const showNavigationTarget = StateEffect.define<{ from: number; to: number }>();

/** Keeps the target highlighted until the user moves the cursor or edits. */
export const navigationHighlight = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    for (const effect of transaction.effects)
      if (effect.is(showNavigationTarget)) {
        const { from, to } = effect.value;
        const line = transaction.state.doc.lineAt(from);
        const end = Math.min(to, line.to);
        return Decoration.set(
          [
            Decoration.line({ class: 'cm-navigation-target' }).range(line.from),
            ...(end > from
              ? [Decoration.mark({ class: 'cm-navigation-symbol' }).range(from, end)]
              : []),
          ],
          true,
        );
      }
    if (transaction.docChanged || transaction.isUserEvent('select')) return Decoration.none;
    return value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** Moves the cursor to `from`, centers it and highlights the target up to `to`. */
export function revealNavigationTarget(view: EditorView, from: number, to: number) {
  view.dispatch({
    selection: { anchor: from },
    effects: [
      EditorView.scrollIntoView(from, { y: 'center' }),
      showNavigationTarget.of({ from, to }),
    ],
  });
}
