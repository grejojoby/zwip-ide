import { syntaxTree } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';

// Declarations whose header stays visible while their body scrolls, across the bundled grammars.
const scope =
  /^(?:FunctionDecl|MethodDecl|FunctionLiteral|TypeSpec|FunctionDeclaration|MethodDeclaration|ClassDeclaration|InterfaceDeclaration|EnumDeclaration|ArrowFunction|FunctionExpression)$/;
const MAX_LINES = 3;

/** Lines (1-based) that open the declarations enclosing the first visible line, outermost first. */
export function stickyScopeLines(view: EditorView): number[] {
  const top = view.lineBlockAtHeight(view.scrollDOM.scrollTop);
  const topLine = view.state.doc.lineAt(top.from).number;
  const lines: number[] = [];
  for (let node = syntaxTree(view.state).resolveInner(top.from, 1).node; node.parent;) {
    if (scope.test(node.name)) {
      const line = view.state.doc.lineAt(node.from).number;
      // Only headers already scrolled past, and only while the body is still in view.
      if (line < topLine && view.state.doc.lineAt(node.to).number > topLine) lines.unshift(line);
    }
    node = node.parent;
  }
  return lines.slice(-MAX_LINES);
}

/** IntelliJ's sticky lines: the enclosing function header pinned above a long body. */
export function stickyLines(): Extension {
  return ViewPlugin.fromClass(
    class {
      readonly dom = document.createElement('div');
      private shown = '';
      constructor(readonly view: EditorView) {
        this.dom.className = 'cm-sticky-lines';
        this.dom.addEventListener('mousedown', (event) => {
          const line = Number((event.target as HTMLElement).dataset.line);
          if (!line) return;
          event.preventDefault();
          const from = view.state.doc.line(line).from;
          view.dispatch({ selection: { anchor: from }, effects: EditorView.scrollIntoView(from) });
          view.focus();
        });
        view.dom.appendChild(this.dom);
        this.render();
        view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true });
      }
      private onScroll = () => this.render();
      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged || update.geometryChanged) this.render();
      }
      render() {
        const lines = stickyScopeLines(this.view);
        const key = lines
          .map((line) => `${line}:${this.view.state.doc.line(line).text}`)
          .join('\n');
        if (key === this.shown) return;
        this.shown = key;
        this.dom.replaceChildren(
          ...lines.map((line) => {
            const row = document.createElement('div');
            row.dataset.line = String(line);
            row.textContent = this.view.state.doc.line(line).text;
            return row;
          }),
        );
        this.dom.hidden = !lines.length;
        this.view.requestMeasure({
          read: (view) =>
            view.contentDOM.getBoundingClientRect().left - view.dom.getBoundingClientRect().left,
          write: (left) => (this.dom.style.paddingLeft = `${left}px`),
        });
      }
      destroy() {
        this.view.scrollDOM.removeEventListener('scroll', this.onScroll);
        this.dom.remove();
      }
    },
  );
}
