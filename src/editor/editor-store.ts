import { Transaction, type EditorState } from '@codemirror/state';
import { externalDocumentChange } from './external-change';
import type { EditorView } from '@codemirror/view';
import type { DocumentSnapshot, Position } from '../contracts';
import { api } from '../api';
import { DocumentSession } from '../model/document-session';

export interface OpenEditor {
  sourceContextId?: string;
  editingLocked?: boolean;
  session: DocumentSession;
  state: EditorState | null;
  initial: string;
  views: Set<EditorView>;
  /** Notified after every editor transaction that changes the document text. */
  changeListeners: Set<() => void>;
  pendingPosition?: Position;
}
export class EditorStore {
  readonly documents = new Map<string, OpenEditor>();
  private epoch = 0;
  private pending = new Map<string, Promise<OpenEditor>>();
  private editingLocks = 0;
  constructor(private changed: () => void) {}
  async open(path: string): Promise<OpenEditor> {
    const existing = this.documents.get(path);
    if (existing) return existing;
    const request = this.pending.get(path);
    if (request) return request;
    const epoch = this.epoch;
    const promise = api
      .openDocument(path)
      .then((snapshot) => {
        if (epoch !== this.epoch) throw new Error('Workspace changed while opening the document');
        return this.add(snapshot);
      })
      .finally(() => {
        if (epoch === this.epoch) this.pending.delete(path);
      });
    this.pending.set(path, promise);
    return promise;
  }
  private add(snapshot: DocumentSnapshot): OpenEditor {
    const document: OpenEditor = {
      session: new DocumentSession(snapshot, api, this.changed),
      state: null,
      initial: snapshot.content,
      views: new Set(),
      changeListeners: new Set(),
      editingLocked: this.editingLocks > 0,
    };
    this.documents.set(snapshot.path, document);
    this.changed();
    return document;
  }
  async flushAll(): Promise<void> {
    await Promise.all([...this.documents.values()].map((doc) => doc.session.flush()));
  }
  /** Applied synchronously, before React can mount the operation's modal barrier. */
  lockEditing(): () => void {
    this.editingLocks += 1;
    for (const doc of this.documents.values()) doc.editingLocked = true;
    this.changed();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.editingLocks -= 1;
      for (const doc of this.documents.values()) doc.editingLocked = this.editingLocks > 0;
      this.changed();
    };
  }
  async close(path: string): Promise<boolean> {
    const doc = this.documents.get(path);
    if (!doc) return true;
    const epoch = this.epoch;
    const revision = await doc.session.flush();
    if (epoch !== this.epoch || this.documents.get(path) !== doc || doc.session.dirty) return false;
    const version = doc.session.version;
    const { released } = await api.closeDocument(path, revision);
    if (
      !released ||
      epoch !== this.epoch ||
      this.documents.get(path) !== doc ||
      doc.session.dirty ||
      doc.session.version !== version ||
      doc.session.revision !== revision
    )
      return false;
    this.documents.delete(path);
    this.changed();
    return true;
  }
  adoptEdits(snapshots: DocumentSnapshot[]): void {
    for (const snapshot of snapshots) {
      const doc = this.documents.get(snapshot.path);
      if (!doc) {
        this.add(snapshot);
        continue;
      }
      doc.session.acceptApplied(snapshot);
      const change = {
        from: 0,
        to: doc.state?.doc.length ?? doc.initial.length,
        insert: snapshot.content,
      };
      if (doc.views.size)
        for (const view of doc.views)
          view.dispatch({
            changes: { ...change, to: view.state.doc.length },
            annotations: externalDocumentChange.of(true),
          });
      else if (doc.state)
        doc.state = doc.state.update({
          changes: change,
          annotations: externalDocumentChange.of(true),
        }).state;
      else doc.initial = snapshot.content;
    }
  }
  async synchronize(path: string): Promise<'unchanged' | 'reloaded' | 'conflict'> {
    const doc = this.documents.get(path);
    if (!doc) return 'unchanged';
    const epoch = this.epoch;
    return doc.session.synchronize(
      () => api.syncDocument(path),
      (revision) => api.rejectDocumentSync(path, revision),
      (snapshot) => {
        if (epoch !== this.epoch) return;
        const spec = {
          changes: {
            from: 0,
            to: doc.state?.doc.length ?? doc.initial.length,
            insert: snapshot.content,
          },
          annotations: [externalDocumentChange.of(true), Transaction.addToHistory.of(false)],
        };
        if (doc.views.size)
          for (const view of doc.views)
            view.dispatch({ ...spec, changes: { ...spec.changes, to: view.state.doc.length } });
        else if (doc.state) doc.state = doc.state.update(spec).state;
        else doc.initial = snapshot.content;
      },
    );
  }
  hasDirty(): boolean {
    return [...this.documents.values()].some((doc) => doc.session.dirty);
  }
  async saveAll(): Promise<void> {
    for (const doc of this.documents.values()) if (doc.session.dirty) await doc.session.save();
  }
  clear(): void {
    this.epoch += 1;
    this.documents.clear();
    this.pending.clear();
  }
}

export function offsetAt(state: EditorState, position: Position): number {
  const line = state.doc.line(Math.max(1, Math.min(state.doc.lines, position.line + 1)));
  return Math.min(line.to, line.from + Math.max(0, position.character));
}
export function positionAt(state: EditorState, offset: number): Position {
  const line = state.doc.lineAt(offset);
  return { line: line.number - 1, character: offset - line.from };
}
