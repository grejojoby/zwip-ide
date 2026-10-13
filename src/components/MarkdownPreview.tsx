import { useEffect, useMemo, useState } from 'react';
import type { OpenEditor } from '../editor/editor-store';
import { renderMarkdown } from '../model/markdown';

const DEBOUNCE_MS = 120;

export function MarkdownPreview({ document }: { document: OpenEditor }) {
  const [source, setSource] = useState(() => document.state?.doc.toString() ?? document.initial);
  useEffect(() => {
    const read = () => document.state?.doc.toString() ?? document.initial;
    setSource(read());
    let timer: number | undefined;
    const listener = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setSource(read()), DEBOUNCE_MS);
    };
    document.changeListeners.add(listener);
    return () => {
      document.changeListeners.delete(listener);
      window.clearTimeout(timer);
    };
  }, [document]);
  const html = useMemo(() => renderMarkdown(source), [source]);
  return (
    <article
      className="markdown-preview"
      aria-label={`Preview of ${document.session.path.split('/').pop()}`}
      // Safe: renderMarkdown disables raw HTML, so only markdown-it's own elements are produced.
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(event) => {
        // Links must not navigate the application window away from the IDE.
        if ((event.target as HTMLElement).closest('a')) event.preventDefault();
      }}
    />
  );
}
