import { RangeSet, StateEffect, StateField, type Extension } from '@codemirror/state';
import { GutterMarker, gutter } from '@codemirror/view';

/** One `git.blame` row; `line` is 1-based and `authorTime` is in Unix seconds. */
export interface BlameLine {
  line: number;
  commit: string;
  author: string;
  authorTime: number;
  summary: string;
}

class BlameMarker extends GutterMarker {
  constructor(
    readonly label: string,
    readonly title: string,
  ) {
    super();
  }
  eq(other: BlameMarker) {
    return other.label === this.label && other.title === this.title;
  }
  toDOM() {
    const element = document.createElement('span');
    element.textContent = this.label;
    element.title = this.title;
    return element;
  }
}

/** Replaces the annotations; null hides the blame gutter. */
export const setBlame = StateEffect.define<BlameLine[] | null>();

const uncommitted = /^0+$/;
const blameField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(markers, transaction) {
    // Annotations follow their lines through edits; inserted lines have none.
    markers = markers.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (!effect.is(setBlame)) continue;
      const doc = transaction.state.doc;
      markers = RangeSet.of(
        (effect.value ?? [])
          .filter((row) => row.line >= 1 && row.line <= doc.lines && !uncommitted.test(row.commit))
          .map((row) => {
            const date = new Date(row.authorTime * 1000).toLocaleDateString();
            return new BlameMarker(
              `${date} ${row.author}`,
              `${row.commit.slice(0, 8)} · ${row.author} · ${date}\n${row.summary}`,
            ).range(doc.line(row.line).from);
          }),
        true,
      );
    }
    return markers;
  },
});

/** IntelliJ's "Annotate with Git Blame": author and date beside each committed line. */
export function blameGutter(): Extension {
  return [
    blameField,
    gutter({ class: 'cm-blame-gutter', markers: (view) => view.state.field(blameField) }),
  ];
}
