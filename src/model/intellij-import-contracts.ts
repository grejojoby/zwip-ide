import type { Connection } from '../contracts';

export interface IntelliJKeymapAction {
  id: string;
  shortcuts: { first: string; second?: string }[];
  hasMouse: boolean;
}

export interface IntelliJKeymap {
  name: string;
  parent?: string;
  actions: IntelliJKeymapAction[];
}

export interface IntelliJConnectionCandidate {
  id: string;
  name: string;
  status: 'ready' | 'unsupported' | 'duplicate';
  connection?: Connection;
  notes: string[];
}

export interface IntelliJImportPreview {
  source: string;
  fingerprint: string;
  keymaps: IntelliJKeymap[];
  activeKeymap?: string;
  connections: IntelliJConnectionCandidate[];
  runConfigurations: IntelliJRunConfiguration[];
  appearance?: { dark: boolean; name: string };
  notices: string[];
}

export interface IntelliJRunConfiguration {
  id: string;
  name: string;
  type: string;
  status: 'ready' | 'unsupported';
  fields: {
    workingDirectory?: string;
    packageJson?: string;
    command?: string;
    scripts?: string[];
    nodeInterpreter?: string;
    packageManager?: string;
    goKind?: string;
    filePath?: string;
    packagePath?: string;
    directoryPath?: string;
    programParameters?: string;
    goParameters?: string;
    pattern?: string;
    framework?: string;
  };
  notes: string[];
}

export interface IntelliJConnectionImportResult {
  imported: number;
  connections: Connection[];
}
