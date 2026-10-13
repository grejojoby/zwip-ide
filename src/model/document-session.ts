import type { DocumentSnapshot, DocumentAck, TextDelta } from '../contracts';

type DocumentTransport = {
  changeDocument(path: string, revision: number, changes: TextDelta[]): Promise<DocumentAck>;
  saveDocument(path: string, revision: number): Promise<DocumentSnapshot>;
};

export interface ExternalSyncResult {
  document: DocumentSnapshot;
  changed: boolean;
  conflict: boolean;
  rollbackRevision?: number;
}

/** Serializes deltas, save barriers and semantic reads without putting text in React. */
export class DocumentSession {
  readonly path: string;
  readonly generation: number;
  revision: number;
  dirty: boolean;
  error: Error | null = null;
  private sequence: Promise<void> = Promise.resolve();
  private editVersion = 0;

  constructor(
    snapshot: DocumentSnapshot,
    private transport: DocumentTransport,
    private changed: () => void,
  ) {
    this.path = snapshot.path;
    this.generation = snapshot.workspaceGeneration;
    this.revision = snapshot.revision;
    this.dirty = snapshot.dirty;
  }

  acceptExternal(snapshot: DocumentSnapshot): void {
    if (this.dirty)
      throw new Error(
        'External changes conflict with unsaved edits; the editor buffer has been retained.',
      );
    this.revision = snapshot.revision;
    this.dirty = snapshot.dirty;
    this.error = null;
    this.changed();
  }

  acceptApplied(snapshot: DocumentSnapshot): void {
    if (snapshot.revision < this.revision)
      throw new Error('Workspace edit was superseded by a document change.');
    this.revision = snapshot.revision;
    this.dirty = snapshot.dirty;
    this.error = null;
    this.changed();
  }

  get version(): number {
    return this.editVersion;
  }

  enqueue(changes: TextDelta[]): void {
    if (!changes.length) return;
    this.editVersion += 1;
    const wasDirty = this.dirty;
    this.dirty = true;
    if (!wasDirty) this.changed();
    this.sequence = this.sequence.then(async () => {
      if (this.error) return;
      try {
        const next = await this.transport.changeDocument(
          this.path,
          this.revision,
          [...changes].sort((a, b) => b.from - a.from),
        );
        this.revision = next.revision;
      } catch (error) {
        this.error = asError(error);
        this.changed();
      }
    });
  }

  async flush(): Promise<number> {
    // New keystrokes may join the queue while an earlier IPC is in flight.
    let current;
    do {
      current = this.sequence;
      await current;
    } while (current !== this.sequence);
    if (this.error) throw this.error;
    return this.revision;
  }

  async synchronize(
    read: (revision: number) => Promise<ExternalSyncResult>,
    reject: (syncedRevision: number) => Promise<DocumentSnapshot>,
    apply: (snapshot: DocumentSnapshot) => void,
  ): Promise<'unchanged' | 'reloaded' | 'conflict'> {
    const operation = this.sequence.then(async () => {
      if (this.error) throw this.error;
      const version = this.editVersion;
      const result = await read(this.revision);
      if (result.conflict) return 'conflict' as const;
      if (!result.changed) return 'unchanged' as const;
      if (this.dirty || this.editVersion !== version) {
        if (result.rollbackRevision === undefined)
          throw new Error(
            'External synchronization raced with local edits. Your editor buffer is retained.',
          );
        // Restore the original base before deltas queued during the read are sent.
        // The original disk hash makes a later save reject the external conflict.
        const restored = await reject(result.rollbackRevision);
        this.revision = restored.revision;
        this.dirty = true;
        this.changed();
        return 'conflict' as const;
      }
      this.acceptExternal(result.document);
      apply(result.document);
      return 'reloaded' as const;
    });
    this.sequence = operation
      .then(() => {})
      .catch((error) => {
        this.error = asError(error);
        this.changed();
      });
    return operation;
  }

  async save(): Promise<void> {
    const version = this.editVersion;
    const operation = this.sequence.then(async () => {
      if (this.error) throw this.error;
      const saved = await this.transport.saveDocument(this.path, this.revision);
      this.revision = saved.revision;
      if (version === this.editVersion) this.dirty = false;
      this.changed();
    });
    // A save conflict must not break subsequent change synchronization.
    this.sequence = operation.catch(() => {});
    await operation;
  }
}

export function asError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(typeof error === 'string' ? error : JSON.stringify(error));
}
