import type { NavigationBatch } from '../contracts';

/** Poll cumulative provider progress without allowing a late poll to replace the final result. */
export async function withNavigationProgress(
  query: () => Promise<NavigationBatch>,
  progress: () => Promise<NavigationBatch | null>,
  isActive: () => boolean,
  accept: (batch: NavigationBatch) => boolean,
  onProgress: (batch: NavigationBatch) => void,
): Promise<NavigationBatch> {
  let running = true;
  let timer: ReturnType<typeof setTimeout>;
  async function poll() {
    if (!running || !isActive()) return;
    try {
      const batch = await progress();
      if (running && isActive() && batch?.state === 'loading' && accept(batch)) onProgress(batch);
    } catch {
      // The final request owns errors. A progress transport failure must not
      // replace a successful query or repeatedly interrupt the editor.
    } finally {
      if (running && isActive()) timer = setTimeout(() => void poll(), 100);
    }
  }
  timer = setTimeout(() => void poll(), 100);
  try {
    return await query();
  } finally {
    running = false;
    clearTimeout(timer);
  }
}
