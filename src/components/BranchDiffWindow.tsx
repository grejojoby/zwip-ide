import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { request } from '../api';
import type { DiffHunk, DiffLine, GitDiff } from '../contracts';
import { asError } from '../model/document-session';
import { renderTokens, useHighlightedLines, type Token } from '../editor/highlight';
import { FileIcon } from './FileIcon';
import { Modal } from './Modal';
import { DiffActions } from './DiffActions';

export interface ComparedFile {
  status: string;
  path: string;
}
type ChangeKind = 'modified' | 'inserted' | 'deleted';
interface Segment {
  change?: ChangeKind;
  left: DiffLine[];
  right: DiffLine[];
}
/** One visual row of a pane: a line, a fold of unchanged lines, or a zero-height gap marker. */
type Row =
  | { kind: 'line'; line: DiffLine; change?: ChangeKind; words?: Set<number> }
  | { kind: 'fold'; segment: number; count: number }
  | { kind: 'gap'; change: ChangeKind };
interface Block {
  change: ChangeKind;
  leftTop: number;
  leftRows: number;
  rightTop: number;
  rightRows: number;
}

const ROW = 18;
const CONTEXT = 4;
const CONNECTOR = 34;
const NONE = new Set<number>();

/** Splits the whole-file hunk into runs of unchanged lines and change blocks. */
function segments(hunks: DiffHunk[]): Segment[] {
  const result: Segment[] = [];
  for (const line of hunks.flatMap((hunk) => hunk.lines)) {
    const last = result[result.length - 1];
    if (line.kind === 'context') {
      if (last && !last.change) {
        last.left.push(line);
        last.right.push(line);
      } else result.push({ left: [line], right: [line] });
    } else {
      const block = last?.change ? last : { change: 'modified' as ChangeKind, left: [], right: [] };
      if (block !== last) result.push(block);
      (line.kind === 'remove' ? block.left : block.right).push(line);
      block.change = !block.left.length ? 'inserted' : !block.right.length ? 'deleted' : 'modified';
    }
  }
  return result;
}

const tokens = (text: string) => text.match(/\w+|\s+|[^\w\s]/g) ?? [];
/** Indexes of the tokens on each side that are not part of the longest common subsequence. */
function wordChanges(before: string, after: string): [Set<number>, Set<number>] | null {
  const a = tokens(before);
  const b = tokens(after);
  if (a.length * b.length > 250_000) return null;
  const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1)
    for (let j = b.length - 1; j >= 0; j -= 1)
      table[i][j] =
        a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  const left = new Set<number>();
  const right = new Set<number>();
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i += 1;
      j += 1;
    } else if (j >= b.length || (i < a.length && table[i + 1][j] >= table[i][j + 1])) left.add(i++);
    else right.add(j++);
  }
  return [left, right];
}

function layout(parts: Segment[], collapse: boolean, expanded: Set<number>) {
  const left: Row[] = [];
  const right: Row[] = [];
  const blocks: Block[] = [];
  // Gap markers have no height, so block offsets count visible rows only.
  let gaps = { left: 0, right: 0 };
  parts.forEach((part, index) => {
    if (!part.change) {
      const count = part.left.length;
      const head = index === 0 ? 0 : CONTEXT;
      const tail = index === parts.length - 1 ? 0 : CONTEXT;
      if (collapse && !expanded.has(index) && count > head + tail + 1) {
        for (const side of [left, right]) {
          const lines = side === left ? part.left : part.right;
          lines.slice(0, head).forEach((line) => side.push({ kind: 'line', line }));
          side.push({ kind: 'fold', segment: index, count: count - head - tail });
          lines.slice(count - tail).forEach((line) => side.push({ kind: 'line', line }));
        }
      } else {
        part.left.forEach((line) => left.push({ kind: 'line', line }));
        part.right.forEach((line) => right.push({ kind: 'line', line }));
      }
      return;
    }
    const change = part.change;
    blocks.push({
      change,
      leftTop: left.length - gaps.left,
      leftRows: part.left.length,
      rightTop: right.length - gaps.right,
      rightRows: part.right.length,
    });
    part.left.forEach((line, row) => {
      const pair = part.right[row];
      const words = pair && change === 'modified' ? wordChanges(line.text, pair.text) : null;
      left.push({ kind: 'line', line, change, words: words?.[0] });
      if (pair) right.push({ kind: 'line', line: pair, change, words: words?.[1] });
    });
    part.right
      .slice(part.left.length)
      .forEach((line) => right.push({ kind: 'line', line, change }));
    if (!part.left.length) left.push({ kind: 'gap', change });
    if (!part.right.length) right.push({ kind: 'gap', change });
    gaps = {
      left: gaps.left + Number(!part.left.length),
      right: gaps.right + Number(!part.right.length),
    };
  });
  return { left, right, blocks };
}

/** Maps a scroll offset in one pane to the matching offset in the other, block by block. */
function mapScroll(blocks: Block[], from: 'left' | 'right', offset: number) {
  const line = offset / ROW;
  let delta = 0;
  for (const block of blocks) {
    const [top, rows, otherTop, otherRows] =
      from === 'left'
        ? [block.leftTop, block.leftRows, block.rightTop, block.rightRows]
        : [block.rightTop, block.rightRows, block.leftTop, block.leftRows];
    if (line < top) break;
    if (line < top + rows) return (otherTop + ((line - top) / rows) * otherRows) * ROW;
    delta = otherTop + otherRows - (top + rows);
  }
  return (line + delta) * ROW;
}

/** Syntax-colored line text with changed words marked; plain until highlighting is ready. */
function lineContent(text: string, colored: Token[] | undefined, words?: Set<number>) {
  const marks: [number, number][] = [];
  let offset = 0;
  tokens(text).forEach((token, at) => {
    if (words?.has(at)) marks.push([offset, offset + token.length]);
    offset += token.length;
  });
  if (!text) return ' ';
  return renderTokens(colored ?? [{ text }], marks, 'bdiff-word');
}

function statusClass(status: string) {
  return status === 'A'
    ? 'added'
    : status === 'D'
      ? 'deleted'
      : status === 'M'
        ? 'modified'
        : 'other';
}

export function BranchDiffWindow({
  branch,
  files,
  onClose,
}: {
  branch: string;
  files: ComparedFile[];
  onClose(): void;
}) {
  const ordered = useMemo(() => [...files].sort((a, b) => a.path.localeCompare(b.path)), [files]);
  const [selected, setSelected] = useState(0);
  const [diffs, setDiffs] = useState<Map<string, GitDiff>>(new Map());
  const [error, setError] = useState('');
  const [collapse, setCollapse] = useState(true);
  // Unfolded unchanged runs, by segment index, for the file they were opened in.
  const [expanded, setExpanded] = useState({ path: '', segments: new Set<number>() });
  const [current, setCurrent] = useState(-1);
  const [scroll, setScroll] = useState({ left: 0, right: 0, height: 0 });
  const leftPane = useRef<HTMLDivElement>(null);
  const rightPane = useRef<HTMLDivElement>(null);
  const syncing = useRef<'left' | 'right' | null>(null);
  const file = ordered[selected];
  const diff = file && diffs.get(file.path);

  useEffect(() => {
    if (!file || diffs.has(file.path)) return;
    let active = true;
    setError('');
    request<GitDiff>('git.compareFile', { branch, path: file.path })
      .then((result) => active && setDiffs((map) => new Map(map).set(file.path, result)))
      .catch((e) => active && setError(asError(e).message));
    return () => {
      active = false;
    };
  }, [branch, file, diffs]);

  const parts = useMemo(() => (diff ? segments(diff.hunks) : []), [diff]);
  // Both full versions, highlighted with the editor's grammar for this file type.
  const texts = useMemo(() => {
    if (!diff || diff.binary) return { left: null, right: null };
    const lines = diff.hunks.flatMap((hunk) => hunk.lines);
    const join = (kind: 'add' | 'remove') =>
      lines
        .filter((line) => line.kind !== kind)
        .map((line) => line.text)
        .join('\n');
    return { left: join('add'), right: join('remove') };
  }, [diff]);
  const colors = {
    left: useHighlightedLines(file?.path ?? '', texts.left),
    right: useHighlightedLines(file?.path ?? '', texts.right),
  };
  const unfolded = expanded.path === file?.path ? expanded.segments : NONE;
  const view = useMemo(() => layout(parts, collapse, unfolded), [parts, collapse, unfolded]);
  useLayoutEffect(() => {
    setCurrent(-1);
    for (const pane of [leftPane.current, rightPane.current]) if (pane) pane.scrollTop = 0;
  }, [file?.path]);
  // Like IntelliJ, opening a file moves to its first difference.
  useLayoutEffect(() => {
    if (diff && !diff.binary) goToDifference(0);
  }, [diff]);
  useLayoutEffect(() => {
    const pane = leftPane.current;
    if (pane)
      setScroll({
        left: pane.scrollTop,
        right: rightPane.current?.scrollTop ?? 0,
        height: pane.clientHeight,
      });
  }, [view]);

  function onScroll(side: 'left' | 'right') {
    const source = side === 'left' ? leftPane.current : rightPane.current;
    const target = side === 'left' ? rightPane.current : leftPane.current;
    if (!source || !target) return;
    if (syncing.current === side) syncing.current = null;
    else {
      const next = mapScroll(view.blocks, side, source.scrollTop);
      if (Math.abs(target.scrollTop - next) >= 1) {
        syncing.current = side === 'left' ? 'right' : 'left';
        target.scrollTop = next;
      }
    }
    setScroll({
      left: leftPane.current!.scrollTop,
      right: rightPane.current!.scrollTop,
      height: source.clientHeight,
    });
  }
  function goToDifference(index: number) {
    const block = view.blocks[index];
    const pane = leftPane.current;
    if (!block || !pane) return;
    setCurrent(index);
    pane.scrollTop = Math.max(0, block.leftTop * ROW - pane.clientHeight / 3);
  }
  function step(direction: 1 | -1) {
    const next = current + direction;
    if (next >= 0 && next < view.blocks.length) goToDifference(next);
    else if (direction === 1 && selected < ordered.length - 1) setSelected(selected + 1);
    else if (direction === -1 && selected > 0) setSelected(selected - 1);
  }

  const groups = useMemo(() => {
    const map = new Map<string, number[]>();
    ordered.forEach((item, index) => {
      const dir = item.path.includes('/') ? item.path.slice(0, item.path.lastIndexOf('/')) : '';
      map.set(dir, [...(map.get(dir) ?? []), index]);
    });
    return [...map];
  }, [ordered]);

  const currentPart = parts.filter((part) => part.change)[current];

  const pane = (side: 'left' | 'right', rows: Row[]): ReactNode =>
    rows.map((row, index) => {
      if (row.kind === 'gap')
        return <div key={index} className={`bdiff-gap bdiff-${row.change}`} aria-hidden="true" />;
      if (row.kind === 'fold')
        return (
          <button
            key={index}
            className="bdiff-fold"
            onClick={() =>
              setExpanded({ path: file.path, segments: new Set(unfolded).add(row.segment) })
            }
          >
            {row.count} unchanged line{row.count === 1 ? '' : 's'}
          </button>
        );
      const number = side === 'left' ? row.line.oldLine : row.line.newLine;
      return (
        <div key={index} className={`bdiff-line ${row.change ? `bdiff-${row.change}` : ''}`}>
          <span className="bdiff-number">{number}</span>
          <code>{lineContent(row.line.text, colors[side]?.[(number ?? 0) - 1], row.words)}</code>
        </div>
      );
    });

  return (
    <Modal title={`Diff: '${branch}' vs working tree`} onClose={onClose}>
      <div
        className="bdiff-window"
        onKeyDown={(event) => {
          if (event.key === 'F7') {
            event.preventDefault();
            step(event.shiftKey ? -1 : 1);
          }
        }}
      >
        <div className="bdiff-toolbar" role="toolbar" aria-label="Diff actions">
          <button
            title="Previous Difference (Shift+F7)"
            aria-label="Previous difference"
            onClick={() => step(-1)}
          >
            ↑
          </button>
          <button title="Next Difference (F7)" aria-label="Next difference" onClick={() => step(1)}>
            ↓
          </button>
          <button
            title="Previous File"
            aria-label="Previous file"
            disabled={selected === 0}
            onClick={() => setSelected(selected - 1)}
          >
            ←
          </button>
          <button
            title="Next File"
            aria-label="Next file"
            disabled={selected >= ordered.length - 1}
            onClick={() => setSelected(selected + 1)}
          >
            →
          </button>
          <button aria-pressed={collapse} onClick={() => setCollapse(!collapse)}>
            Collapse Unchanged Fragments
          </button>
          {diff && currentPart && (
            <DiffActions
              key={`hunk:${diff.path}:${diff.fingerprint}:${current}`}
              diff={diff}
              changeIds={currentPart.left.concat(currentPart.right).map((line) => line.id)}
              label="Revert current difference…"
              onReverted={() => setDiffs(new Map())}
            />
          )}
          {diff && (
            <DiffActions
              key={`${diff.path}:${diff.fingerprint}`}
              diff={diff}
              onEdit={onClose}
              onReverted={() => setDiffs(new Map())}
            />
          )}
          <button
            onClick={() => {
              setError('');
              setDiffs(new Map());
            }}
          >
            Refresh diff
          </button>
          <span className="spacer" />
          <span className="muted">
            {diff && !diff.binary
              ? `${view.blocks.length} difference${view.blocks.length === 1 ? '' : 's'}`
              : ''}
            {ordered.length ? ` · file ${selected + 1} of ${ordered.length}` : ''}
          </span>
        </div>
        <div className="bdiff-body">
          <div
            role="tree"
            aria-label="Changed files"
            className="bdiff-tree"
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                const next = selected + (event.key === 'ArrowDown' ? 1 : -1);
                if (next >= 0 && next < ordered.length) setSelected(next);
              }
            }}
          >
            <div className="bdiff-tree-root">
              Tracked files · {ordered.length} changed
              <span className="muted">Untracked files are not compared.</span>
            </div>
            {groups.map(([dir, indexes]) => (
              <div key={dir} role="group">
                {dir && <div className="bdiff-dir">{dir}</div>}
                {indexes.map((at) => (
                  <div
                    key={ordered[at].path}
                    role="treeitem"
                    aria-selected={at === selected}
                    className={`bdiff-file bdiff-status-${statusClass(ordered[at].status)} ${dir ? 'nested' : ''}`}
                    title={ordered[at].path}
                    onClick={() => setSelected(at)}
                  >
                    <FileIcon path={ordered[at].path} />
                    {ordered[at].path.split('/').pop()}
                  </div>
                ))}
              </div>
            ))}
          </div>
          <div className="bdiff-viewer">
            {!file ? (
              <p className="empty-note">No file differences.</p>
            ) : (
              <>
                <div className="bdiff-headers">
                  <div title={file.path}>
                    <strong>{branch}</strong> <span className="muted">{file.path}</span>
                  </div>
                  <div className="bdiff-header-gap" style={{ width: CONNECTOR }} />
                  <div>
                    <strong>Your version</strong> <span className="muted">{file.path}</span>
                  </div>
                </div>
                {error ? (
                  <p role="alert" className="error-message empty-note">
                    {error}
                  </p>
                ) : !diff ? (
                  <p className="empty-note">Loading…</p>
                ) : diff.binary ? (
                  <p className="empty-note">Binary file · contents are not shown</p>
                ) : !parts.length ? (
                  <p className="empty-note">Contents are identical</p>
                ) : (
                  <div className="bdiff-panes">
                    <div
                      ref={leftPane}
                      className="bdiff-pane"
                      aria-label={`${branch} version`}
                      onScroll={() => onScroll('left')}
                    >
                      {pane('left', view.left)}
                    </div>
                    <svg
                      className="bdiff-connector"
                      width={CONNECTOR}
                      height={scroll.height}
                      aria-hidden="true"
                    >
                      {view.blocks.map((block, index) => {
                        const y1 = block.leftTop * ROW - scroll.left;
                        const y2 = (block.leftTop + block.leftRows) * ROW - scroll.left;
                        const y3 = (block.rightTop + block.rightRows) * ROW - scroll.right;
                        const y4 = block.rightTop * ROW - scroll.right;
                        if (
                          Math.max(y1, y2, y3, y4) < 0 ||
                          Math.min(y1, y2, y3, y4) > scroll.height
                        )
                          return null;
                        const c = CONNECTOR / 2;
                        return (
                          <path
                            key={index}
                            className={`bdiff-${block.change} ${index === current ? 'current' : ''}`}
                            d={`M0 ${y1} C${c} ${y1} ${c} ${y4} ${CONNECTOR} ${y4} L${CONNECTOR} ${y3} C${c} ${y3} ${c} ${y2} 0 ${y2} Z`}
                          />
                        );
                      })}
                    </svg>
                    <div
                      ref={rightPane}
                      className="bdiff-pane"
                      aria-label="Working tree version"
                      onScroll={() => onScroll('right')}
                    >
                      {pane('right', view.right)}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
