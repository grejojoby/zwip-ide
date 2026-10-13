import type { SourceRange } from '../contracts';
export interface CoverageFile {
  path: string;
  fileHash: string;
  coveredStatements: number;
  totalStatements: number;
  percent: number;
  blocks: { range: SourceRange; count: number; statements: number }[];
}
export interface CoverageReport {
  files: CoverageFile[];
  percent: number;
}
export interface GoTestEvent {
  Action: string;
  Package: string;
  Test?: string;
  Output?: string;
  Elapsed?: number;
}
export interface GoJob {
  id: string;
  status: 'running' | 'completed' | 'failed' | 'canceled';
  cursor: number;
  events: {
    sequence: number;
    kind: 'test' | 'output';
    stream?: string;
    text?: string;
    test?: GoTestEvent;
  }[];
  droppedBefore?: number;
  exitCode?: number;
  coverage?: CoverageReport;
  reasons: string[];
}
export interface DebugEvent {
  sequence: number;
  event: string;
  body?: Record<string, unknown>;
}
export interface GoResult {
  state: string;
  reasons: string[];
  job?: GoJob;
  sessionId?: string;
  cursor?: number;
  status?: string;
  events?: DebugEvent[];
  droppedBefore?: number;
  response?: { success: boolean; message?: string; body?: unknown };
}
export interface DebugFrame {
  id: number;
  name: string;
  line: number;
  column: number;
  source?: { path?: string; name?: string };
}
export interface DebugVariable {
  name: string;
  value: string;
  type?: string;
  variablesReference: number;
}
