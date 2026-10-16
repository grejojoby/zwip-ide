import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { BuildContext } from '../contracts';
import { warming } from '../model/build-contexts';

/** Files indexed so far while a workspace scan runs; null when no scan is running. */
export function useScanProgress(scanning: boolean): { files: number; validating?: boolean } | null {
  const [files, setFiles] = useState<{ files: number; validating?: boolean } | null>(null);
  useEffect(() => {
    if (!scanning) {
      setFiles(null);
      return;
    }
    let active = true;
    const timer = setInterval(() => {
      api
        .scanProgress()
        .then((reply) => {
          if (active) setFiles(reply);
        })
        .catch(() => undefined);
    }, 250);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [scanning]);
  return files;
}

const stateLabel: Record<BuildContext['state'], string> = {
  loading: 'Indexing',
  ready: 'Ready',
  failed: 'Failed',
  unavailable: 'Unavailable',
};
const stateOrder: Record<BuildContext['state'], number> = {
  loading: 0,
  failed: 1,
  unavailable: 2,
  ready: 3,
};

/** Workspace-relative module directory, with its build profile when one is set. */
function contextLabel(context: BuildContext, root: string): string {
  const base = root.replace(/\/$/, '');
  const dir = context.root.replace(/\/$/, '');
  const relative =
    dir === base ? '.' : dir.startsWith(base + '/') ? dir.slice(base.length + 1) : dir;
  return context.profileId ? `${relative} (${context.profileId})` : relative;
}

/** Status bar progress for the file scan, then for build contexts still loading.
 * Clicking the context progress lists every module with its provider-reported state. */
export function IndexingStatus({
  scannedFiles,
  contexts,
  validatingFiles = false,
  root = '',
}: {
  scannedFiles: number | null;
  validatingFiles?: boolean;
  contexts: readonly BuildContext[];
  root?: string;
}) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  }, [open]);
  if (scannedFiles !== null)
    return (
      <span
        className="indexing-status"
        role="progressbar"
        aria-label={validatingFiles ? 'Validating saved index' : 'Indexing files'}
      >
        <progress />
        {validatingFiles ? 'Validating saved index…' : 'Indexing files…'}{' '}
        {scannedFiles.toLocaleString()}
      </span>
    );
  const done = contexts.filter((context) => context.state !== 'loading').length;
  // Once every module has loaded, background package indexing (if any) is the remaining work.
  const packages = contexts.filter(warming);
  const total = packages.reduce((sum, context) => sum + (context.packages ?? 0), 0);
  const indexed = packages.reduce((sum, context) => sum + (context.indexed ?? 0), 0);
  const modulesDone = done === contexts.length;
  const saved = contexts.filter((context) => context.indexState === 'restored').length;
  const issues = contexts.filter((context) =>
    ['failed', 'missing', 'invalidated'].includes(context.indexState ?? ''),
  );
  const settled = modulesDone && !packages.length;
  if (settled && !saved && !issues.length) return null;
  const validating = packages.some((context) => context.indexState === 'validating');
  const units = packages.every((context) => context.indexUnits === 'files') ? 'files' : 'packages';
  const sorted = [...contexts].sort(
    (a, b) =>
      stateOrder[a.state] - stateOrder[b.state] ||
      contextLabel(a, root).localeCompare(contextLabel(b, root)),
  );
  return (
    <span className="indexing-status-anchor" ref={container}>
      <button
        type="button"
        className="indexing-status"
        role={settled ? undefined : 'progressbar'}
        aria-label={
          settled
            ? 'Workspace index status'
            : validating
              ? 'Validating saved index'
              : modulesDone
                ? `Indexing ${units}`
                : 'Indexing build contexts'
        }
        aria-valuemin={0}
        aria-valuemax={modulesDone ? total : contexts.length}
        aria-valuenow={modulesDone ? indexed : done}
        aria-expanded={open}
        title="Show indexing progress per module"
        onClick={() => setOpen((value) => !value)}
      >
        {settled ? (
          issues.length ? (
            'Index needs attention'
          ) : (
            `Index loaded (${saved}/${contexts.length})`
          )
        ) : modulesDone ? (
          <>
            <progress value={indexed} max={total} />
            {validating ? 'Validating saved index' : `Indexing ${units}`} {indexed.toLocaleString()}
            /{total.toLocaleString()}
          </>
        ) : (
          <>
            <progress value={done} max={contexts.length} />
            Indexing {done}/{contexts.length}
          </>
        )}
      </button>
      {open && (
        <div
          className="indexing-panel"
          role="dialog"
          aria-label="Indexing progress per module"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              setOpen(false);
            }
          }}
        >
          <div className="indexing-panel-header">
            Modules: {done} of {contexts.length} done
          </div>
          <ul className="indexing-panel-list">
            {sorted.map((context) => (
              <li key={context.id} className="indexing-panel-row" data-state={context.state}>
                <span className="indexing-panel-state">
                  {context.indexState === 'restored'
                    ? 'Loaded'
                    : context.indexState === 'validating'
                      ? 'Validating'
                      : context.indexState === 'building'
                        ? 'Indexing'
                        : context.indexState === 'built'
                          ? 'Saved'
                          : context.indexState === 'failed'
                            ? 'Cache failed'
                            : context.indexState === 'missing'
                              ? 'Not saved'
                              : context.indexState === 'invalidated'
                                ? 'Changed'
                                : stateLabel[context.state]}
                </span>
                <span className="indexing-panel-name" title={context.configPath}>
                  {contextLabel(context, root)}
                </span>
                {!!context.packages && (
                  <span className="indexing-panel-reason">
                    {context.indexed ?? 0}/{context.packages} {context.indexUnits ?? 'packages'}
                  </span>
                )}
                {context.indexReason && (
                  <span className="indexing-panel-reason">{context.indexReason}</span>
                )}
                {context.reason && (
                  <span className="indexing-panel-reason" title={context.reason}>
                    {context.reason}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </span>
  );
}
