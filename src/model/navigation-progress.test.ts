import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NavigationBatch } from '../contracts';
import { withNavigationProgress } from './navigation-progress';
import { isCurrentResult } from './navigation';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const batch: NavigationBatch = {
  id: 'current',
  documentRevision: 3,
  workspaceGeneration: 2,
  state: 'loading',
  locations: [],
  searchedContexts: 1,
  totalContexts: 3,
  reasons: [],
};
afterEach(() => vi.useRealTimers());
describe('navigation progress lifetime', () => {
  it('streams only matching cumulative batches and never overwrites a settled query', async () => {
    vi.useFakeTimers();
    const final = deferred<NavigationBatch>();
    const late = deferred<NavigationBatch | null>();
    const read = vi
      .fn()
      .mockResolvedValueOnce({ ...batch, documentRevision: 2 })
      .mockResolvedValueOnce(batch)
      .mockImplementationOnce(() => late.promise);
    const render = vi.fn();
    const result = withNavigationProgress(
      () => final.promise,
      read,
      () => true,
      (reply) => isCurrentResult(reply, 'current', 3, 2),
      render,
    );
    await vi.advanceTimersByTimeAsync(300);
    expect(render).toHaveBeenCalledExactlyOnceWith(batch);
    final.resolve({ ...batch, state: 'complete', searchedContexts: 3 });
    expect((await result).state).toBe('complete');
    late.resolve({ ...batch, searchedContexts: 2 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(render).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(3);
  });
  it('stops after cancellation or document replacement even with a slow poll in flight', async () => {
    vi.useFakeTimers();
    const final = deferred<NavigationBatch>();
    const pending = deferred<NavigationBatch | null>();
    let active = true;
    const read = vi.fn(() => pending.promise);
    const render = vi.fn();
    const result = withNavigationProgress(
      () => final.promise,
      read,
      () => active,
      () => true,
      render,
    );
    await vi.advanceTimersByTimeAsync(500);
    expect(read).toHaveBeenCalledTimes(1);
    active = false;
    pending.resolve(batch);
    await vi.advanceTimersByTimeAsync(1000);
    expect(render).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(1);
    final.resolve({ ...batch, state: 'canceled' });
    await result;
  });
});
