import { RangeSet, StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, GutterMarker, gutter, type DecorationSet } from '@codemirror/view';
export const setBreakpoints = StateEffect.define<number[]>();
export const setCoverage = StateEffect.define<{ line: number; count: number }[]>();
export const setExecutionLine = StateEffect.define<number | null>();
class BreakpointMarker extends GutterMarker {
  toDOM() {
    const marker = document.createElement('span');
    marker.className = 'breakpoint-marker';
    marker.textContent = '●';
    marker.setAttribute('aria-label', 'Breakpoint');
    return marker;
  }
}
class CoverageMarker extends GutterMarker {
  constructor(readonly count: number) {
    super();
  }
  toDOM() {
    const marker = document.createElement('span');
    marker.className = this.count > 0 ? 'coverage-hit' : 'coverage-miss';
    marker.textContent = '▏';
    marker.title =
      this.count > 0 ? `Coverage: ${this.count} executions` : 'Uncovered statements on this line';
    return marker;
  }
}
const breakpointMarker = new BreakpointMarker();
export const breakpointField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(value, transaction) {
    value = value.map(transaction.changes);
    for (const effect of transaction.effects)
      if (effect.is(setBreakpoints))
        value = RangeSet.of(
          [...new Set(effect.value)]
            .filter((line) => line >= 0 && line < transaction.state.doc.lines)
            .sort((a, b) => a - b)
            .map((line) => breakpointMarker.range(transaction.state.doc.line(line + 1).from)),
        );
    return value;
  },
});
const coverageField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(value, transaction) {
    if (transaction.docChanged) value = RangeSet.empty;
    for (const effect of transaction.effects)
      if (effect.is(setCoverage))
        value = RangeSet.of(
          effect.value
            .filter((item) => item.line >= 0 && item.line < transaction.state.doc.lines)
            .sort((a, b) => a.line - b.line)
            .map((item) =>
              new CoverageMarker(item.count).range(transaction.state.doc.line(item.line + 1).from),
            ),
        );
    return value;
  },
});
const executionField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    value = value.map(transaction.changes);
    for (const effect of transaction.effects)
      if (effect.is(setExecutionLine))
        value =
          effect.value !== null && effect.value >= 0 && effect.value < transaction.state.doc.lines
            ? Decoration.set([
                Decoration.line({ class: 'debug-execution-line' }).range(
                  transaction.state.doc.line(effect.value + 1).from,
                ),
              ])
            : Decoration.none;
    return value;
  },
  provide: (field) => EditorView.decorations.from(field),
});
export function breakpointLines(view: EditorView): number[] {
  const lines: number[] = [];
  const markers = view.state.field(breakpointField);
  for (let cursor = markers.iter(); cursor.value; cursor.next())
    lines.push(view.state.doc.lineAt(cursor.from).number - 1);
  return lines;
}
export function debugGutters(toggle: (line: number) => void) {
  return [
    breakpointField,
    coverageField,
    executionField,
    gutter({
      class: 'breakpoint-gutter',
      markers: (view) => view.state.field(breakpointField),
      initialSpacer: () => breakpointMarker,
      domEventHandlers: {
        mousedown: (view, line, event) => {
          if (!(event instanceof MouseEvent) || event.button !== 0) return false;
          event.preventDefault();
          toggle(view.state.doc.lineAt(line.from).number - 1);
          return true;
        },
      },
    }),
    gutter({ class: 'coverage-gutter', markers: (view) => view.state.field(coverageField) }),
  ];
}
