import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorStore } from './editor-store';
import { api } from '../api';
import type { DocumentSnapshot } from '../contracts';

vi.mock('../api', () => ({
  api: { openDocument: vi.fn(), closeDocument: vi.fn(), changeDocument: vi.fn() },
}));
const snapshot: DocumentSnapshot = {
  path: '/project/file.txt',
  content: 'original',
  revision: 1,
  workspaceGeneration: 1,
  dirty: false,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.openDocument).mockResolvedValue(snapshot);
  vi.mocked(api.changeDocument).mockResolvedValue({ ...snapshot, revision: 2, dirty: true });
});
describe('document ownership on close', () => {
  it('retains the editor when the backend declines to release its mirror', async () => {
    const store = new EditorStore(() => {});
    const document = await store.open(snapshot.path);
    vi.mocked(api.closeDocument).mockResolvedValue({ released: false });
    expect(await store.close(snapshot.path)).toBe(false);
    expect(store.documents.get(snapshot.path)).toBe(document);
  });
  it('retains an edit that arrives while a close acknowledgement is pending', async () => {
    const store = new EditorStore(() => {});
    const document = await store.open(snapshot.path);
    const reply = deferred<{ released: boolean }>();
    vi.mocked(api.closeDocument).mockReturnValue(reply.promise);
    const closing = store.close(snapshot.path);
    await vi.waitFor(() => expect(api.closeDocument).toHaveBeenCalledWith(snapshot.path, 1));
    document.session.enqueue([{ from: 8, to: 8, insert: '!' }]);
    reply.resolve({ released: true });
    expect(await closing).toBe(false);
    expect(store.documents.get(snapshot.path)).toBe(document);
    await document.session.flush();
    expect(document.session.dirty).toBe(true);
  });
  it('flushes queued changes before deciding whether a document can be closed', async () => {
    const store = new EditorStore(() => {});
    const document = await store.open(snapshot.path);
    const reply = deferred<Awaited<ReturnType<typeof api.changeDocument>>>();
    vi.mocked(api.changeDocument).mockReturnValue(reply.promise);
    document.session.enqueue([{ from: 8, to: 8, insert: '!' }]);
    const closing = store.close(snapshot.path);
    expect(api.closeDocument).not.toHaveBeenCalled();
    reply.resolve({ ...snapshot, revision: 2, dirty: true });
    expect(await closing).toBe(false);
    expect(api.closeDocument).not.toHaveBeenCalled();
    expect(store.documents.get(snapshot.path)).toBe(document);
  });
  it('only drops the same clean editor after successful release', async () => {
    const store = new EditorStore(() => {});
    await store.open(snapshot.path);
    vi.mocked(api.closeDocument).mockResolvedValue({ released: true });
    expect(await store.close(snapshot.path)).toBe(true);
    expect(store.documents.has(snapshot.path)).toBe(false);
  });
});
