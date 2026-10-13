import { useEffect, useState } from 'react';
import { api } from '../api';
import type { BuildContext } from '../contracts';

/** Files indexed so far while a workspace scan runs; null when no scan is running. */
export function useScanProgress(scanning: boolean): number | null {
  const [files, setFiles] = useState<number | null>(null);
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
          if (active) setFiles(reply.files);
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

/** Status bar progress for the file scan, then for build contexts still loading. */
export function IndexingStatus({
  scannedFiles,
  contexts,
}: {
  scannedFiles: number | null;
  contexts: readonly BuildContext[];
}) {
  if (scannedFiles !== null)
    return (
      <span className="indexing-status" role="progressbar" aria-label="Indexing files">
        <progress />
        Indexing files… {scannedFiles.toLocaleString()}
      </span>
    );
  const done = contexts.filter((context) => context.state !== 'loading').length;
  if (done === contexts.length) return null;
  return (
    <span
      className="indexing-status"
      role="progressbar"
      aria-label="Indexing build contexts"
      aria-valuemin={0}
      aria-valuemax={contexts.length}
      aria-valuenow={done}
    >
      <progress value={done} max={contexts.length} />
      Indexing {done}/{contexts.length}
    </span>
  );
}
