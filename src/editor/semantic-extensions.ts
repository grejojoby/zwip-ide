import { EditorView, hoverTooltip } from '@codemirror/view';
import { autocompletion, completionKeymap } from '@codemirror/autocomplete';
import { linter, lintGutter } from '@codemirror/lint';
import { keymap } from '@codemirror/view';
import type { EditorOperation, EditorResult, Position, SemanticEdit } from '../contracts';
import { offsetAt, positionAt, type OpenEditor } from './editor-store';
export interface SemanticCallbacks {
  onRequest?(operation: EditorOperation, position?: Position): Promise<EditorResult | null>;
  onApplyEdits?(edits: SemanticEdit[], title: string): void;
  onAction?(action: 'format' | 'rename' | 'codeActions'): void;
}
export function semanticExtensions(doc: OpenEditor, callbacks: () => SemanticCallbacks) {
  return [
    keymap.of(completionKeymap),
    autocompletion({
      override: [
        async (context) => {
          const word = context.matchBefore(/[\w$]*/);
          if (!context.explicit && (!word || word.from === word.to)) return null;
          const version = doc.session.version;
          const sourceContextId = doc.sourceContextId;
          const response = await callbacks().onRequest?.(
            'completion',
            positionAt(context.state, context.pos),
          );
          if (
            !response ||
            context.aborted ||
            doc.session.version !== version ||
            doc.sourceContextId !== sourceContextId ||
            response.state !== 'complete'
          )
            return null;
          return {
            from: word?.from ?? context.pos,
            options: (response.completions ?? []).map((item) => ({
              label: item.label,
              detail: item.detail,
              apply(view: EditorView, _completion: unknown, from: number, to: number) {
                if (doc.session.version !== version || doc.sourceContextId !== sourceContextId)
                  return;
                const range = item.range ?? {
                  start: positionAt(view.state, from),
                  end: positionAt(view.state, to),
                };
                if (item.additionalEdits?.length)
                  callbacks().onApplyEdits?.(
                    [
                      {
                        path: doc.session.path,
                        revision: response.documentRevision,
                        range,
                        newText: item.insertText,
                      },
                      ...item.additionalEdits,
                    ],
                    `Complete ${item.label}`,
                  );
                else
                  view.dispatch({
                    changes: {
                      from: offsetAt(view.state, range.start),
                      to: offsetAt(view.state, range.end),
                      insert: item.insertText,
                    },
                    selection: {
                      anchor: offsetAt(view.state, range.start) + item.insertText.length,
                    },
                  });
              },
            })),
          };
        },
      ],
    }),
    hoverTooltip(
      async (view, position) => {
        const response = await callbacks().onRequest?.('hover', positionAt(view.state, position));
        if (!response?.hover || response.state !== 'complete') return null;
        return {
          pos: position,
          above: true,
          create() {
            const dom = document.createElement('div');
            dom.className = 'semantic-hover';
            dom.textContent = response.hover!;
            return { dom };
          },
        };
      },
      { hoverTime: 500 },
    ),
    lintGutter(),
    linter(
      async (view) => {
        const response = await callbacks().onRequest?.('diagnostics');
        if (!response || !['complete', 'partial'].includes(response.state)) return [];
        return (response.diagnostics ?? []).map((item) => ({
          from: offsetAt(view.state, item.range.start),
          to: offsetAt(view.state, item.range.end),
          severity: item.severity === 'information' ? ('info' as const) : item.severity,
          message: item.message,
          source: item.source,
        }));
      },
      { delay: 650 },
    ),
  ];
}
