import { describe, expect, it, vi } from 'vitest';
import { DocumentSession } from './document-session';
import type { DocumentSnapshot } from '../contracts';
const initial: DocumentSnapshot = {
  path: '/project/main.ts',
  content: 'ab',
  revision: 1,
  workspaceGeneration: 2,
  dirty: false,
};
describe('document synchronization', () => {
  it('orders deltas and uses acknowledged revisions before save', async () => {
    const calls: string[] = [];
    const transport = {
      changeDocument: vi.fn(async (_path, revision, deltas) => {
        calls.push(`change:${revision}:${deltas[0].from}`);
        return { ...initial, revision: revision + 1, dirty: true };
      }),
      saveDocument: vi.fn(async (_path, revision) => {
        calls.push(`save:${revision}`);
        return { ...initial, revision, dirty: false };
      }),
    };
    const session = new DocumentSession(initial, transport, () => {});
    session.enqueue([
      { from: 0, to: 0, insert: 'a' },
      { from: 2, to: 2, insert: 'b' },
    ]);
    session.enqueue([{ from: 1, to: 1, insert: 'x' }]);
    await session.save();
    expect(calls).toEqual(['change:1:2', 'change:2:1', 'save:3']);
    expect(session.dirty).toBe(false);
  });
  it('retains dirty state for edits made during a save', async () => {
    let saved!: () => void;
    const pending = new Promise<void>((resolve) => {
      saved = resolve;
    });
    const transport = {
      changeDocument: vi.fn(async (_path, revision) => ({ ...initial, revision: revision + 1 })),
      saveDocument: vi.fn(async () => {
        await pending;
        return initial;
      }),
    };
    const session = new DocumentSession(initial, transport, () => {});
    const save = session.save();
    session.enqueue([{ from: 0, to: 0, insert: 'new' }]);
    saved();
    await save;
    await session.flush();
    expect(session.dirty).toBe(true);
  });
  it('blocks semantic reads after synchronization failure without discarding changes', async () => {
    const transport = {
      changeDocument: vi.fn(async () => {
        throw new Error('revision conflict');
      }),
      saveDocument: vi.fn(async () => initial),
    };
    const session = new DocumentSession(initial, transport, () => {});
    session.enqueue([{ from: 0, to: 0, insert: 'new' }]);
    await expect(session.flush()).rejects.toThrow('revision conflict');
    await expect(session.save()).rejects.toThrow('revision conflict');
    expect(session.dirty).toBe(true);
    expect(transport.saveDocument).not.toHaveBeenCalled();
  });
});

it('rolls back a racing external reload before queued local deltas, preserving the old disk baseline', async () => {
  const calls: string[] = [];
  let release!: (result: import('./document-session').ExternalSyncResult) => void;
  const pending = new Promise<import('./document-session').ExternalSyncResult>((resolve) => {
    release = resolve;
  });
  const transport = {
    changeDocument: vi.fn(async (_path: string, revision: number) => {
      calls.push(`change:${revision}`);
      return { ...initial, revision: revision + 1, dirty: true };
    }),
    saveDocument: vi.fn(async () => initial),
  };
  const session = new DocumentSession(initial, transport, () => {});
  const apply = vi.fn();
  const sync = session.synchronize(
    async () => {
      calls.push('read');
      return pending;
    },
    async (revision) => {
      calls.push(`reject:${revision}`);
      return { ...initial, revision: revision + 1, dirty: true };
    },
    apply,
  );
  await Promise.resolve();
  session.enqueue([{ from: 2, to: 2, insert: 'new local text' }]);
  release({
    changed: true,
    conflict: false,
    rollbackRevision: 2,
    document: { ...initial, content: 'different external content', revision: 2 },
  });
  expect(await sync).toBe('conflict');
  await session.flush();
  expect(calls).toEqual(['read', 'reject:2', 'change:3']);
  expect(apply).not.toHaveBeenCalled();
  expect(session.revision).toBe(4);
  expect(session.dirty).toBe(true);
  expect(session.error).toBeNull();
});
