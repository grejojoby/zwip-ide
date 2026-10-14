import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { listen } from '@tauri-apps/api/event';
// Already in the main bundle: the syntax runtime shares it with downloaded grammars.
import { closeCompletion } from '@codemirror/autocomplete';
import { api, newWindow, request } from './api';
import type {
  EditorOperation,
  EditorResult,
  NavigationBatch,
  GitDiff,
  NavigationOperation,
  Position,
  SearchMatch,
  SemanticDiagnostic,
  SemanticEdit,
  SourceLocation,
  WorkspaceEditPreview,
  WorkspaceSnapshot,
} from './contracts';
import { EditorStore, offsetAt, positionAt } from './editor/editor-store';
import type { EditorView } from '@codemirror/view';
import { foldAll, foldCode, unfoldAll, unfoldCode } from '@codemirror/language';
import type { BlameLine } from './editor/blame-gutter';
import { EditorContextMenu, type MenuEntry } from './components/EditorContextMenu';
const GoTools = lazy(() =>
  import('./components/tools/GoTools').then((module) => ({ default: module.GoTools })),
);
import { coverageLines as coverageForFile, matchesCoverage } from './model/go-results';
import type { CoverageReport } from './model/go-types';
const DatabasePanel = lazy(() =>
  import('./components/tools/DatabasePanel').then((module) => ({ default: module.DatabasePanel })),
);
const HttpPanel = lazy(() =>
  import('./components/tools/HttpPanel').then((module) => ({ default: module.HttpPanel })),
);
const TerminalPanel = lazy(() =>
  import('./components/TerminalPanel').then((module) => ({ default: module.TerminalPanel })),
);
const CodeEditor = lazy(() =>
  import('./editor/CodeEditor').then((module) => ({ default: module.CodeEditor })),
);
import { asError } from './model/document-session';
import { isCurrentResult, NavigationHistory, shouldFindUsages } from './model/navigation';
import { withNavigationProgress } from './model/navigation-progress';
import { mergeContextUpdates } from './model/build-contexts';
import { Icon } from './components/Icon';
import { BranchPopup } from './components/BranchPopup';
import { IntelliJImport } from './components/IntelliJImport';
import { PartialDiff } from './components/PartialDiff';
import { MarkdownPreview } from './components/MarkdownPreview';
import { Modal } from './components/Modal';
import { isMarkdownPath } from './model/markdown';
import { ProjectTree } from './components/ProjectTree';
import { SidebarRail, SidebarMoveButton } from './components/SidebarRail';
import {
  defaultSidebarLayout,
  readSidebarLayout,
  moveSidebarTool,
  openSidebarTool,
  toggleSidebarTool,
  closeSidebar,
  sidebarTools,
  sidebarLabels,
  type SidebarSide,
  type SidebarTool,
} from './model/sidebar-layout';
import { BuildContextSelector } from './components/BuildContextSelector';
import { FileActions, type FileActionResult } from './components/FileActions';
import { HierarchyTree, type HierarchyOperation } from './components/HierarchyTree';
import { NavigationResults } from './components/NavigationResults';
import { TargetChooser } from './components/TargetChooser';
import { UsagesPopup, type PopupAnchor } from './components/UsagesPopup';
import { FileSearch } from './components/FileSearch';
import { CommandSearch, type ActionCommand } from './components/CommandSearch';
import { GitPanel, type Selection as GitSelection } from './components/GitPanel';
import { Packages } from './components/Packages';
import { IndexingStatus, useScanProgress } from './components/IndexingStatus';
import { TaskPanel } from './components/TaskPanel';
import { HistoryPanel } from './components/HistoryPanel';
import { Recovery } from './components/Recovery';
import { EditPreview } from './components/EditPreview';
import { SymbolSearch } from './components/SymbolSearch';
import { Settings, type HistoryPreferences } from './components/Settings';
import { loadPreference } from './model/preferences';
import {
  EDITOR_FONT,
  UI_ZOOM,
  nextUiZoom,
  setEditorFontSize,
  setUiZoom,
  zoomDirection,
} from './model/zoom';
import { useWorkspaceTasks } from './model/use-workspace-tasks';
import { runDirectory } from './model/run-configurations';
import type { PreparedGoTarget } from './components/tools/GoTools';
import {
  canonicalShortcut,
  defaultShortcuts,
  doubleTapRecognizer,
  matchesShortcut as matchesKeystroke,
  normalizedShortcuts,
  shortcutLabel,
  type Shortcuts,
  type ShortcutAction,
} from './model/shortcuts';
import { RenameDialog } from './components/RenameDialog';
import { WhatsNew } from './components/WhatsNew';
import { updates } from './content/updates';

type AuxiliaryTool = 'database' | 'http' | 'git';
type SidebarAction =
  | { kind: 'move'; tool: SidebarTool; side: SidebarSide }
  | { kind: 'open'; tool: SidebarTool }
  | { kind: 'toggle'; tool: SidebarTool }
  | { kind: 'close'; side: SidebarSide };
type Tool = 'terminal' | 'problems' | 'usages' | 'search' | 'run' | 'history' | 'go';
const titles: Record<NavigationOperation, string> = {
  definition: 'Declarations',
  typeDefinition: 'Type declarations',
  references: 'Usages',
  implementations: 'Implementations',
  typeHierarchy: 'Type hierarchy',
  incomingCalls: 'Incoming calls',
  outgoingCalls: 'Outgoing calls',
};

export function App() {
  const [, redraw] = useState(0);
  const store = useRef<EditorStore | null>(null);
  if (!store.current) store.current = new EditorStore(() => redraw((value) => value + 1));
  const documents = store.current;
  const history = useRef(new NavigationHistory());
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot | null>(null);
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  async function setDirectoryExcluded(path: string, excluded: boolean) {
    setStatus(excluded ? `Excluding ${path}…` : `Including ${path}…`);
    const next = await api.setDirectoryExcluded(path, excluded).catch((e: unknown) => {
      setStatus(`Could not update ${path}: ${asError(e).message}`);
      return null;
    });
    if (!next) return;
    workspaceRef.current = next;
    setWorkspace(next);
    setStatus(
      excluded
        ? `Excluded ${path} from search and indexing`
        : `Included ${path} in search and indexing`,
    );
  }
  const [editorMenu, setEditorMenu] = useState<{
    x: number;
    y: number;
    view: EditorView;
    path: string;
  } | null>(null);
  const [blame, setBlame] = useState<Record<string, BlameLine[]>>({});
  const [stickyLines, setStickyLines] = useState(false);
  function changeStickyLines(enabled: boolean) {
    setStickyLines(enabled);
    void api.setSetting('zwip.stickyLines', enabled).catch(report);
  }
  async function toggleBlame(path: string) {
    if (blame[path]) {
      setBlame(({ [path]: _hidden, ...rest }) => rest);
      return;
    }
    try {
      const lines = await request<BlameLine[]>('git.blame', { path });
      setBlame((current) => ({ ...current, [path]: lines }));
    } catch (e) {
      setStatus(`Git blame: ${asError(e).message}`);
    }
  }
  /** `path:line`, workspace-relative, as IntelliJ's Copy Reference gives for a line. */
  function copyReference(path: string, line: number) {
    const root = workspaceRef.current?.root;
    const reference = `${root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path}:${line}`;
    void navigator.clipboard
      .writeText(reference)
      .then(() => setStatus(`Copied ${reference}`))
      .catch(report);
  }
  /** The editor popup, grouped and ordered like IntelliJ's EditorPopupMenu. */
  function editorMenuEntries(view: EditorView, path: string): MenuEntry[] {
    const key = (action: ShortcutAction) => shortcutLabel(shortcuts[action]) || undefined;
    const at = () => positionAt(view.state, view.state.selection.main.head);
    const selection = view.state.selection.main;
    const editable = !view.state.readOnly;
    const config = selectedRunConfiguration;
    const copy = () =>
      navigator.clipboard.writeText(view.state.sliceDoc(selection.from, selection.to));
    return [
      {
        label: 'Show Context Actions',
        shortcut: key('fixes'),
        run: () => void editorAction('codeActions', path),
      },
      'separator',
      {
        label: 'Cut',
        shortcut: '⌘X',
        disabled: selection.empty || !editable,
        run: () =>
          void copy()
            .then(() => view.dispatch({ changes: { from: selection.from, to: selection.to } }))
            .catch(report),
      },
      {
        label: 'Copy',
        shortcut: '⌘C',
        disabled: selection.empty,
        run: () => void copy().catch(report),
      },
      {
        label: 'Copy Reference',
        shortcut: key('copyReference'),
        run: () => copyReference(path, view.state.doc.lineAt(selection.head).number),
      },
      {
        label: 'Paste',
        shortcut: '⌘V',
        disabled: !editable,
        run: () =>
          void navigator.clipboard
            .readText()
            .then((text) => {
              view.dispatch(view.state.replaceSelection(text));
              view.focus();
            })
            .catch(report),
      },
      'separator',
      {
        label: 'Find Usages',
        shortcut: key('usages'),
        run: () => void navigate('references', at(), path),
      },
      {
        label: 'Refactor',
        children: [
          {
            label: 'Rename…',
            shortcut: key('rename'),
            disabled: !editable,
            run: () => void editorAction('rename', path),
          },
        ],
      },
      {
        label: 'Folding',
        children: [
          { label: 'Expand', shortcut: '⌥⌘]', run: () => unfoldCode(view) },
          { label: 'Collapse', shortcut: '⌥⌘[', run: () => foldCode(view) },
          'separator',
          { label: 'Expand All', shortcut: '⌃⌥]', run: () => unfoldAll(view) },
          { label: 'Collapse All', shortcut: '⌃⌥[', run: () => foldAll(view) },
        ],
      },
      'separator',
      {
        label: 'Go To',
        children: [
          {
            label: 'Declaration or Usages',
            shortcut: key('declaration'),
            run: () => void navigate('smart', at(), path),
          },
          {
            label: 'Implementation(s)',
            shortcut: key('implementations'),
            run: () => void navigate('implementations', at(), path),
          },
          { label: 'Type Declaration', run: () => void navigate('typeDefinition', at(), path) },
        ],
      },
      {
        label: 'Reformat Code',
        shortcut: key('format'),
        disabled: !editable,
        run: () => void editorAction('format', path),
      },
      'separator',
      {
        label: config ? `Run '${config.name}'` : 'Run',
        disabled: !config || !!workspaceTasks.state.task?.running,
        run: () => {
          setTool('run');
          void workspaceTasks.session.runSelected();
        },
      },
      {
        label: config ? `Debug '${config.name}'` : 'Debug',
        disabled: !config?.debug,
        run: () => debugSelectedConfiguration(),
      },
      'separator',
      {
        label: 'Git',
        children: [
          {
            label: 'Annotate with Git Blame',
            checked: !!blame[path],
            run: () => void toggleBlame(path),
          },
        ],
      },
    ];
  }
  /** Starts the selected configuration's Go debug target right away, like IntelliJ's Debug. */
  function debugSelectedConfiguration() {
    const config = selectedRunConfiguration;
    const root = workspaceRef.current?.root;
    if (!config?.debug || !root) return;
    try {
      setConfiguredGoTarget({
        path: runDirectory(root, config.debug.path),
        workingDirectory: runDirectory(root, config.debug.workingDirectory),
        args: config.debug.args,
        env: config.env,
        mode: config.debug.mode,
        start: Date.now(),
      });
      setGoOpen(true);
      setTool('go');
    } catch (e) {
      setStatus(asError(e).message);
    }
  }
  const [tabs, setTabs] = useState<string[]>([]);
  const [active, setActive] = useState<string>();
  const [split, setSplit] = useState<string>();
  const [diffTabs, setDiffTabs] = useState<GitDiff[]>([]);
  const [activeDiff, setActiveDiff] = useState<string>();
  const [gitSelection, setGitSelection] = useState(new Map<string, GitSelection>());
  const [markdownPreview, setMarkdownPreview] = useState(false);
  const [showRunImport, setShowRunImport] = useState(false);
  const [showBranches, setShowBranches] = useState(false);
  const [gitRevision, setGitRevision] = useState(0);
  const [focusPane, setFocusPane] = useState<'main' | 'split'>('main');
  const focusPath = focusPane === 'split' ? split : active;
  const [position, setPosition] = useState<Position>({ line: 0, character: 0 });
  const [shortcuts, setShortcuts] = useState<Shortcuts>(defaultShortcuts);
  const [historyPreferences, setHistoryPreferences] = useState<HistoryPreferences>({
    retentionDays: 7,
    maxBytes: 64 * 1024 * 1024,
  });
  const [globalPreferencesReady, setGlobalPreferencesReady] = useState(false);
  const [hydratedWorkspace, setHydratedWorkspace] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [showRecovery, setShowRecovery] = useState(false);
  const [showContexts, setShowContexts] = useState(false);
  const [dark, setDark] = useState(true);
  const [treeWidth, setTreeWidth] = useState(248);
  const [toolHeight, setToolHeight] = useState(280);
  const [tool, setTool] = useState<Tool | null>(null);
  const [sidebarLayout, setSidebarLayout] = useState(defaultSidebarLayout);
  const sidebarLayoutRef = useRef(sidebarLayout);
  const sidebarWrites = useRef<Promise<void>>(Promise.resolve());
  const sidebarHydration = useRef(0);
  const [gitVisited, setGitVisited] = useState(false);
  const [auxiliaryWidth, setAuxiliaryWidth] = useState(480);
  const [httpSource, setHttpSource] = useState('');
  const [databaseDirty, setDatabaseDirty] = useState(false);
  const [pendingSidebar, setPendingSidebar] = useState<SidebarAction | null>(null);
  const [goOpen, setGoOpen] = useState(false);
  const [configuredGoTarget, setConfiguredGoTarget] = useState<PreparedGoTarget>();
  const [breakpoints, setBreakpoints] = useState<Record<string, number[]>>({});
  const [coverageLines, setCoverageLines] = useState<
    Record<string, { line: number; count: number }[]>
  >({});
  const latestCoverage = useRef<CoverageReport | null>(null);
  const [execution, setExecution] = useState<{ path: string; line: number } | null>(null);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [branch, setBranch] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('Ready');
  const [opening, setOpening] = useState(false);
  const scannedFiles = useScanProgress(opening);
  const [closing, setClosing] = useState(false);
  const lifecycleBusy = useRef(false);
  const [recentRoots, setRecentRoots] = useState<string[]>([]);
  const [recentFiles, setRecentFiles] = useState<string[]>([]);
  const [showSymbols, setShowSymbols] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const [showActions, setShowActions] = useState(false);
  const [showPackages, setShowPackages] = useState(false);
  const [showWhatsNew, setShowWhatsNew] = useState(false);
  const [hasNewUpdates, setHasNewUpdates] = useState(false);
  const updatesDismissed = useRef(false);
  const [closePath, setClosePath] = useState<string>();
  const [pendingRoot, setPendingRoot] = useState<string>();
  const [targets, setTargets] = useState<SourceLocation[] | null>(null);
  const [usagesPopup, setUsagesPopup] = useState<{ anchor: PopupAnchor; symbol: string } | null>(
    null,
  );
  // Files the usage preview opened without a tab; released once the popup and its navigation end.
  const previewDocuments = useRef(new Set<string>());
  const [batch, setBatch] = useState<NavigationBatch | null>(null);
  const [navigationOperation, setNavigationOperation] = useState<NavigationOperation>('references');
  const [navigationTitle, setNavigationTitle] = useState('Usages');
  const [navigating, setNavigating] = useState(false);
  const requestId = useRef<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [matches, setMatches] = useState<SearchMatch[]>([]);
  const [searching, setSearching] = useState(false);
  const [diagnostics, setDiagnostics] = useState(new Map<string, SemanticDiagnostic[]>());
  const [editPreview, setEditPreview] = useState<WorkspaceEditPreview | null>(null);
  const [editTitle, setEditTitle] = useState('Preview changes');
  const [editBusy, setEditBusy] = useState(false);
  const [rename, setRename] = useState(false);
  const [codeActions, setCodeActions] = useState<NonNullable<EditorResult['codeActions']> | null>(
    null,
  );
  const searchId = useRef(0);
  const report = (e: unknown) => setError(asError(e).message);
  const workspaceTasks = useWorkspaceTasks(workspace?.root);
  const selectedRunConfiguration = workspaceTasks.state.settings.configurations.find(
    (config) => config.id === workspaceTasks.state.settings.selectedId,
  );

  const uiZoom = useRef<number>(UI_ZOOM.initial);
  useEffect(() => {
    // ⌘+ / ⌘− / ⌘0 zoom the whole IDE, also while a dialog is open.
    const key = (event: KeyboardEvent) => {
      const direction = zoomDirection(event);
      if (!direction || !('__TAURI_INTERNALS__' in window)) return;
      event.preventDefault();
      uiZoom.current = nextUiZoom(uiZoom.current, direction);
      void setUiZoom(uiZoom.current).catch(report);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  useEffect(() => {
    // Zwip → Settings… (⌘,) in the native application menu.
    if (!('__TAURI_INTERNALS__' in window)) return;
    const stop = listen('zwip://open-settings', () => setShowSettings(true)).catch(() => null);
    return () => void stop.then((unlisten) => unlisten?.());
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    if (globalPreferencesReady) void api.setSetting('zwip.theme', dark).catch(report);
  }, [dark, globalPreferencesReady]);
  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return;
    let alive = true;
    void Promise.all([
      loadPreference('zwip.theme', true),
      loadPreference<string[]>('zwip.recentRoots', []),
      loadPreference<Partial<Shortcuts>>('shortcuts', {}),
      loadPreference<HistoryPreferences>('history', {
        retentionDays: 7,
        maxBytes: 64 * 1024 * 1024,
      }),
      loadPreference<string | null>('zwip.updates.lastSeen', null),
      loadPreference('zwip.uiZoom', UI_ZOOM.initial),
      loadPreference('zwip.editorFontSize', EDITOR_FONT.initial),
      loadPreference('zwip.stickyLines', false),
    ])
      .then(([theme, roots, keys, retention, lastSeenUpdate, zoom, fontSize, sticky]) => {
        if (!alive) return;
        setStickyLines(sticky);
        uiZoom.current = zoom;
        if (zoom !== UI_ZOOM.initial) void setUiZoom(zoom, false).catch(report);
        setEditorFontSize(fontSize, false);
        setDark(theme);
        setRecentRoots(roots);
        setShortcuts(normalizedShortcuts(keys));
        setHistoryPreferences(retention);
        setGlobalPreferencesReady(true);
        // A window opened for a project ("Open in new window") loads it once.
        const startRoot = new URLSearchParams(location.search).get('root');
        if (startRoot) {
          window.history.replaceState(null, '', location.pathname);
          void loadWorkspace(startRoot);
        }
        if (!updatesDismissed.current && lastSeenUpdate !== updates[0].id) setHasNewUpdates(true);
      })
      .catch(report);
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    if (!hasNewUpdates || showWhatsNew || updatesDismissed.current) return;
    let presented = false;
    const tryOpen = () => {
      if (presented || lifecycleBusy.current || document.querySelector('dialog[open]')) return;
      presented = true;
      observer.disconnect();
      setShowWhatsNew(true);
    };
    // Observe only while a new update waits behind a dialog, including package-owned dialogs.
    const observer = new MutationObserver(tryOpen);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['open'],
    });
    tryOpen();
    return () => observer.disconnect();
  }, [hasNewUpdates, showWhatsNew, opening, closing]);
  function closeWhatsNew() {
    updatesDismissed.current = true;
    setShowWhatsNew(false);
    setHasNewUpdates(false);
    if ('__TAURI_INTERNALS__' in window)
      void api.setSetting('zwip.updates.lastSeen', updates[0].id).catch(() => {
        setHasNewUpdates(true);
        setError(
          'Could not remember that you read What’s new. It may appear again on the next launch.',
        );
      });
  }
  useEffect(() => {
    if (!workspace) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function pollReadiness() {
      let loading = false;
      try {
        const reply = await api.workspaceStatus();
        loading = reply.contexts.some((context) => context.state === 'loading');
        if (active && reply.contexts.length)
          setWorkspace((current) => {
            if (!current || current.generation !== reply.generation) return current;
            return {
              ...current,
              contexts: mergeContextUpdates(current.contexts, reply.contexts),
            };
          });
      } catch {
        /* A workspace transition may briefly invalidate this read. */
      } finally {
        // Poll faster while contexts are still indexing so the status bar progress stays current.
        if (active) timer = setTimeout(() => void pollReadiness(), loading ? 1000 : 5000);
      }
    }
    timer = setTimeout(() => void pollReadiness(), 500);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [workspace?.generation]);
  useEffect(() => {
    if (!workspace) return;
    let listening = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const { paths, configurationChanged } = await api.workspaceChanges();
        if (!listening) return;
        const current = workspaceRef.current;
        if (!current || !paths.length) return;
        if (paths.length)
          setCoverageLines((current) => {
            const next = { ...current };
            for (const path of paths) delete next[path];
            return next;
          });
        const known = new Set(current.files.map((file) => file.path));
        for (const path of paths) {
          if (!documents.documents.has(path)) continue;
          try {
            const result = await documents.synchronize(path);
            if (result === 'conflict')
              setError(
                `External changes conflict with unsaved edits in ${path.split('/').pop()}. Your editor buffer has been retained.`,
              );
            else if (result === 'reloaded')
              setStatus(`Reloaded ${path.split('/').pop()} after external changes`);
          } catch (e) {
            if (listening) report(e);
          }
        }
        if (configurationChanged || paths.some((path) => !known.has(path))) {
          const refreshed = await api.rescanWorkspace(configurationChanged);
          if (listening) {
            workspaceRef.current = refreshed;
            setWorkspace(refreshed);
          }
        }
      } catch (e) {
        if (listening) report(e);
      } finally {
        if (listening) timer = setTimeout(() => void poll(), 1000);
      }
    }
    timer = setTimeout(() => void poll(), 1000);
    return () => {
      listening = false;
      clearTimeout(timer);
    };
  }, [workspace?.root, documents]);
  async function loadWorkspace(root: string) {
    if (lifecycleBusy.current) return;
    if (documents.hasDirty()) {
      setPendingRoot(root);
      return;
    }
    lifecycleBusy.current = true;
    const unlock = documents.lockEditing();
    setOpening(true);
    cancelNavigation();
    setTargets(null);
    searchId.current += 1;
    setSearching(false);
    setError('');
    setStatus('Opening workspace…');
    try {
      await documents.flushAll();
      if (documents.hasDirty()) {
        setPendingRoot(root);
        setStatus('Save open changes before switching workspaces');
        return;
      }
      await sidebarWrites.current;
      const next = await api.openWorkspace(root);
      root = next.root; // Settings and hydration share the canonical workspace identity.
      const hydration = ++sidebarHydration.current;
      setHydratedWorkspace('');
      documents.clear();
      setGoOpen(false);
      setConfiguredGoTarget(undefined);
      setBreakpoints({});
      setCoverageLines({});
      latestCoverage.current = null;
      setExecution(null);
      setTerminalOpen(false);
      setWorkspace(next);
      workspaceRef.current = next;
      setTabs([]);
      setActive(undefined);
      setDiffTabs([]);
      setActiveDiff(undefined);
      setSplit(undefined);
      setFocusPane('main');
      setBatch(null);
      setDiagnostics(new Map());
      setEditPreview(null);
      setCodeActions(null);
      setRename(false);
      setMatches([]);
      setTool(null);
      setTreeWidth(248);
      setToolHeight(280);
      const initialSidebar = defaultSidebarLayout();
      setSidebarLayout(initialSidebar);
      sidebarLayoutRef.current = initialSidebar;
      setGitVisited(false);
      setPendingSidebar(null);
      setDatabaseDirty(false);
      setAuxiliaryWidth(480);
      setRecentFiles([]);
      history.current = new NavigationHistory();
      void Promise.all([
        loadPreference(`zwip.${root}.treeWidth`, 248),
        loadPreference(`zwip.${root}.toolHeight`, 280),
        loadPreference<Tool | 'git' | null>(`zwip.${root}.tool`, null),
        loadPreference(`zwip.${root}.auxiliaryWidth`, 480),
        loadPreference<AuxiliaryTool | null>(`zwip.${root}.auxiliary`, null),
        loadPreference<Record<string, number[]>>(`zwip.${root}.breakpoints`, {}),
        loadPreference<unknown>(`zwip.${root}.sidebarLayout`, null),
      ])
        .then(([tree, height, restoredTool, width, restoredAuxiliary, points, savedLayout]) => {
          if (sidebarHydration.current !== hydration || workspaceRef.current?.root !== next.root)
            return;
          setTreeWidth(tree);
          setToolHeight(height);
          setTool(restoredTool === 'git' ? null : restoredTool);
          setTerminalOpen(restoredTool === 'terminal');
          setGoOpen(restoredTool === 'go');
          setAuxiliaryWidth(width);
          const layout = readSidebarLayout(
            savedLayout,
            restoredAuxiliary ?? (restoredTool === 'git' ? 'git' : null),
          );
          sidebarLayoutRef.current = layout;
          setSidebarLayout(layout);
          setGitVisited(layout.active[layout.placements.git] === 'git');
          setBreakpoints(points);
          setHydratedWorkspace(root);
        })
        .catch(report);
      if (requestId.current) void api.cancelNavigation(requestId.current).catch(() => {});
      requestId.current = null;
      setNavigating(false);
      const roots = [root, ...recentRoots.filter((item) => item !== root)].slice(0, 8);
      setRecentRoots(roots);
      void api.setSetting('zwip.recentRoots', roots).catch(report);
      setStatus(`${next.contexts.length} build contexts discovered`);
      api
        .gitStatus()
        .then((snapshot) => {
          if (workspaceRef.current?.generation === next.generation) setBranch(snapshot.branch);
        })
        .catch(() => setBranch(''));
    } catch (e) {
      report(e);
      setStatus('Workspace could not be opened');
    } finally {
      setOpening(false);
      unlock();
      lifecycleBusy.current = false;
    }
  }
  async function chooseWorkspace(inNewWindow = false) {
    if (lifecycleBusy.current && !inNewWindow) return;
    try {
      const root = await open({
        directory: true,
        multiple: false,
        title: inNewWindow ? 'Open project in new window' : 'Open project workspace',
      });
      if (root && inNewWindow) await newWindow(root);
      else if (root) await loadWorkspace(root);
    } catch (e) {
      report(e);
    }
  }
  const openSequence = useRef({ main: 0, split: 0 });
  async function openFile(
    path: string,
    target?: Position,
    record = true,
    pane: 'main' | 'split' = focusPane,
    sourceContextId?: string,
    highlightEnd?: Position,
  ) {
    if (lifecycleBusy.current) return;
    const generation = workspaceRef.current?.generation;
    const sequence = ++openSequence.current[pane];
    try {
      const doc = await documents.open(path);
      if (
        lifecycleBusy.current ||
        workspaceRef.current?.generation !== generation ||
        openSequence.current[pane] !== sequence
      )
        return;
      if (sourceContextId !== undefined || !record) doc.sourceContextId = sourceContextId;
      const fileCoverage = latestCoverage.current?.files.find((file) => file.path === path);
      if (
        fileCoverage &&
        !(await matchesCoverage(doc.state?.doc.toString() ?? doc.initial, fileCoverage.fileHash))
      )
        setCoverageLines((current) => {
          const next = { ...current };
          delete next[path];
          return next;
        });
      if (
        lifecycleBusy.current ||
        workspaceRef.current?.generation !== generation ||
        openSequence.current[pane] !== sequence
      )
        return;
      if (record)
        history.current.visit(path, target ?? { line: 0, character: 0 }, doc.sourceContextId);
      setTabs((current) => (current.includes(path) ? current : [...current, path]));
      if (pane === 'split' && split) setSplit(path);
      else {
        setActive(path);
        setActiveDiff(undefined);
        setFocusPane('main');
      }
      setRecentFiles((current) => [path, ...current.filter((item) => item !== path)].slice(0, 100));
      if (target) {
        doc.pendingPosition = target;
        doc.pendingHighlight = highlightEnd;
        const reveal =
          highlightEnd && (await import('./editor/navigation-highlight')).revealNavigationTarget;
        for (const view of doc.views) {
          const anchor = offsetAt(view.state, target);
          if (reveal && highlightEnd) reveal(view, anchor, offsetAt(view.state, highlightEnd));
          else view.dispatch({ selection: { anchor }, scrollIntoView: true });
          view.focus();
          doc.pendingPosition = undefined;
          doc.pendingHighlight = undefined;
        }
        setPosition(target);
      }
    } catch (e) {
      report(e);
    }
  }
  async function save(path = focusPath) {
    if (!path) return;
    try {
      await documents.documents.get(path)?.session.save();
      setStatus('Saved');
    } catch (e) {
      report(e);
    }
  }
  async function fileActionApplied(result: FileActionResult) {
    if (result.operation === 'rename' || result.operation === 'trash') {
      const previous = result.previousPath;
      const next = result.operation === 'rename' ? result.path : undefined;
      // Core has already released the clean old mirror. Closing it again would
      // recreate or reject a document at a path which no longer exists.
      documents.documents.delete(previous);
      history.current.relocate(previous, next);
      const remaining = tabs.filter((path) => path !== previous);
      setTabs(remaining);
      if (active === previous) setActive(remaining.at(-1));
      if (split === previous) setSplit(undefined);
      setRecentFiles((current) =>
        current.flatMap((path) => (path === previous ? (next ? [next] : []) : [path])),
      );
      setBreakpoints((current) => {
        const updated = { ...current };
        if (next && current[previous]) updated[next] = current[previous];
        delete updated[previous];
        return updated;
      });
      setCoverageLines((current) => {
        const updated = { ...current };
        delete updated[previous];
        return updated;
      });
      setDiagnostics((current) => {
        const updated = new Map(current);
        updated.delete(previous);
        return updated;
      });
      cancelNavigation();
      setBatch(null);
      setTargets(null);
    }
    const refreshed = await api.rescanWorkspace(false);
    workspaceRef.current = refreshed;
    setWorkspace(refreshed);
    if (result.operation !== 'directory' && result.operation !== 'trash')
      await openFile(result.path, undefined, true, 'main');
    setStatus(
      result.operation === 'trash'
        ? 'File moved to recoverable IDE trash'
        : result.operation === 'rename'
          ? 'File moved'
          : result.operation === 'restore'
            ? 'File restored'
            : result.operation === 'directory'
              ? 'Folder created'
              : 'File created',
    );
  }
  async function removeTab(path: string) {
    if (lifecycleBusy.current) return;
    lifecycleBusy.current = true;
    const unlock = documents.lockEditing();
    setClosing(true);
    try {
      if (!(await documents.close(path))) {
        setError(
          'The document could not be released. Your editor buffer and tab have been retained.',
        );
        if (documents.documents.get(path)?.session.dirty) setClosePath(path);
        return;
      }
      setTabs((current) => {
        const next = current.filter((item) => item !== path);
        if (active === path) setActive(next.at(-1));
        return next;
      });
      if (split === path) {
        setSplit(undefined);
        setFocusPane('main');
      }
      setClosePath(undefined);
    } catch (error) {
      report(error);
    } finally {
      setClosing(false);
      unlock();
      lifecycleBusy.current = false;
    }
  }
  function openDiff(diff: GitDiff) {
    setDiffTabs((current) =>
      current.some((item) => item.path === diff.path)
        ? current.map((item) => (item.path === diff.path ? diff : item))
        : [...current, diff],
    );
    setActiveDiff(diff.path);
  }
  function chooseDiffLines(diff: GitDiff, ids: Set<string>) {
    setGitSelection((current) => {
      const next = new Map(current);
      if (ids.size) next.set(diff.path, { changes: ids, fingerprint: diff.fingerprint });
      else next.delete(diff.path);
      return next;
    });
  }
  function closeDiff(path: string) {
    setDiffTabs((current) => current.filter((item) => item.path !== path));
    setActiveDiff((current) => (current === path ? undefined : current));
  }
  function closeTab(path: string) {
    if (lifecycleBusy.current) return;
    if (documents.documents.get(path)?.session.dirty) setClosePath(path);
    else void removeTab(path);
  }
  function cancelNavigation() {
    const id = requestId.current;
    requestId.current = null;
    setNavigating(false);
    setBatch((current) => (current ? { ...current, state: 'canceled' } : null));
    if (id) void api.cancelNavigation(id).catch(report);
  }
  async function selectSourceContext(path: string, sourceContextId?: string) {
    const doc = documents.documents.get(path);
    if (!doc || doc.sourceContextId === sourceContextId) return;
    doc.sourceContextId = sourceContextId;
    cancelNavigation();
    setTargets(null);
    setBatch(null);
    setCodeActions(null);
    setEditPreview(null);
    setDiagnostics((current) => {
      const next = new Map(current);
      next.delete(path);
      return next;
    });
    history.current.visit(path, position, sourceContextId);
    redraw((value) => value + 1);
    const [{ forceLinting, setDiagnostics: clearDiagnostics }, { closeHoverTooltips }] =
      await Promise.all([import('@codemirror/lint'), import('@codemirror/view')]);
    if (documents.documents.get(path) !== doc || doc.sourceContextId !== sourceContextId) return;
    for (const view of doc.views) {
      closeCompletion(view);
      view.dispatch(clearDiagnostics(view.state, []), { effects: closeHoverTooltips });
      forceLinting(view);
    }
  }
  async function navigate(
    operation: NavigationOperation | 'smart',
    at = position,
    path = focusPath,
  ) {
    if (!path || !workspaceRef.current || lifecycleBusy.current) return;
    const doc = documents.documents.get(path);
    if (!doc) return;
    const old = requestId.current;
    if (old) void api.cancelNavigation(old).catch(() => {});
    const id = crypto.randomUUID();
    requestId.current = id;
    setNavigating(true);
    setError('');
    setTargets(null);
    setBatch(null);
    setUsagesPopup(null);
    const generation = workspaceRef.current.generation;
    // Usages open in a popup under the caret line unless the docked panel already shows them.
    let popupShown = false;
    const showUsagesPopup = () => {
      const view = [...doc.views].find((item) => item.hasFocus) ?? [...doc.views][0];
      if (tool === 'usages' || !view) return false;
      const offset = offsetAt(view.state, at);
      const coords = view.coordsAtPos(offset);
      if (!coords) return false;
      const word = view.state.wordAt(offset);
      setUsagesPopup({
        anchor: { left: coords.left, top: coords.top, bottom: coords.bottom },
        symbol: word ? view.state.sliceDoc(word.from, word.to) : 'symbol',
      });
      return true;
    };
    try {
      const revision = await doc.session.flush();
      const version = doc.session.version;
      const query = {
        id,
        operation: operation === 'smart' ? ('definition' as const) : operation,
        path,
        position: at,
        documentRevision: revision,
        workspaceGeneration: generation,
        sourceContextId: doc.sourceContextId,
      };
      const activeQuery = () =>
        !lifecycleBusy.current &&
        requestId.current === id &&
        documents.documents.get(path) === doc &&
        doc.sourceContextId === query.sourceContextId &&
        doc.session.version === version &&
        workspaceRef.current?.generation === generation;
      const current = (result: NavigationBatch) =>
        activeQuery() && isCurrentResult(result, id, revision, generation);
      const run = (requestedOperation: NavigationOperation) => {
        setNavigationOperation(requestedOperation);
        setNavigationTitle(titles[requestedOperation]);
        if (requestedOperation === 'references' && showUsagesPopup()) popupShown = true;
        // Declarations and implementations open the tool only when there is no single target.
        else if (!['definition', 'typeDefinition', 'implementations'].includes(requestedOperation))
          setTool('usages');
        return withNavigationProgress(
          () => api.navigate({ ...query, operation: requestedOperation }),
          () => api.navigationProgress(id),
          activeQuery,
          current,
          (progress) => {
            setBatch(progress);
            setStatus(
              `${titles[requestedOperation]} · searching · ${progress.searchedContexts}/${progress.totalContexts} contexts`,
            );
          },
        );
      };
      if (!activeQuery()) return;
      let result = await run(query.operation);
      if (!current(result)) return;
      let actual = query.operation;
      if (
        operation === 'smart' &&
        result.state === 'complete' &&
        shouldFindUsages(result.locations, path, at)
      ) {
        actual = 'references';
        result = await run(actual);
        if (!current(result)) return;
      }
      setBatch(result);
      setNavigationOperation(actual);
      setNavigationTitle(titles[actual]);
      if (
        (actual === 'definition' || actual === 'typeDefinition' || actual === 'implementations') &&
        result.state === 'complete' &&
        result.locations.length === 1
      ) {
        history.current.visit(path, at, doc.sourceContextId);
        const location = result.locations[0];
        await openFile(
          location.path,
          location.range.start,
          true,
          focusPane,
          location.contextIds[0],
          location.range.end,
        );
      } else if (
        (actual === 'definition' || actual === 'typeDefinition' || actual === 'implementations') &&
        result.locations.length > 1
      ) {
        setTargets(result.locations);
        setTool('usages');
      } else if (!popupShown) setTool('usages');
      setStatus(
        `${titles[actual]} · ${result.state} · ${result.searchedContexts}/${result.totalContexts} contexts`,
      );
    } catch (e) {
      if (requestId.current === id) report(e);
    } finally {
      if (requestId.current === id) {
        setNavigating(false);
        requestId.current = null;
      }
    }
  }
  async function searchSymbols(query: string, signal: AbortSignal): Promise<NavigationBatch> {
    const generation = workspaceRef.current?.generation;
    if (generation === undefined) throw new Error('Open a workspace first.');
    const id = crypto.randomUUID();
    const cancel = () => {
      void api.cancelNavigation(id).catch(() => {});
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      await documents.flushAll();
      if (signal.aborted) throw new Error('Symbol search canceled.');
      const result = await request<NavigationBatch>('workspace.symbols', {
        id,
        query,
        workspaceGeneration: generation,
      });
      if (
        signal.aborted ||
        workspaceRef.current?.generation !== generation ||
        !isCurrentResult(result, id, 0, generation)
      )
        throw new Error('Workspace changed during symbol search. Try again.');
      return result;
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  }
  async function expandHierarchy(
    location: SourceLocation,
    operation: HierarchyOperation,
    signal: AbortSignal,
  ): Promise<NavigationBatch> {
    const generation = workspaceRef.current?.generation;
    if (generation === undefined) throw new Error('Open a workspace first.');
    const doc = await documents.open(location.path);
    const revision = await doc.session.flush();
    const version = doc.session.version;
    const id = crypto.randomUUID();
    if (signal.aborted) throw new Error('Hierarchy expansion canceled.');
    const cancel = () => {
      void api.cancelNavigation(id).catch(() => {});
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      const result = await api.navigate({
        id,
        operation,
        path: location.path,
        sourceContextId: location.contextIds[0] ?? doc.sourceContextId,
        position: location.range.start,
        documentRevision: revision,
        workspaceGeneration: generation,
      });
      if (
        signal.aborted ||
        doc.session.version !== version ||
        workspaceRef.current?.generation !== generation ||
        !isCurrentResult(result, id, revision, generation)
      )
        throw new Error('Source changed. Run the hierarchy query again.');
      return result;
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  }
  async function editorRequest(
    operation: EditorOperation,
    path: string,
    at?: Position,
    extra: { newName?: string; query?: string } = {},
  ): Promise<EditorResult | null> {
    const doc = documents.documents.get(path);
    const current = workspaceRef.current;
    if (!doc || !current || lifecycleBusy.current) return null;
    try {
      const revision = await doc.session.flush();
      const version = doc.session.version;
      const sourceContextId = doc.sourceContextId;
      const id = crypto.randomUUID();
      const result = await api.editorRequest({
        id,
        operation,
        path,
        position: at,
        documentRevision: revision,
        workspaceGeneration: current.generation,
        sourceContextId,
        ...extra,
      });
      if (
        lifecycleBusy.current ||
        result.id !== id ||
        result.documentRevision !== revision ||
        result.workspaceGeneration !== current.generation ||
        documents.documents.get(path) !== doc ||
        doc.session.version !== version ||
        doc.sourceContextId !== sourceContextId ||
        workspaceRef.current?.generation !== current.generation
      )
        return null;
      if (operation === 'diagnostics')
        setDiagnostics((existing) => {
          const next = new Map(existing);
          next.set(path, result.diagnostics ?? []);
          return next;
        });
      if (result.state !== 'complete')
        setStatus(
          `${operation}: ${result.state}${result.reasons[0] ? ` · ${result.reasons[0]}` : ''}`,
        );
      return result;
    } catch (e) {
      setStatus(`${operation}: ${asError(e).message}`);
      return null;
    }
  }
  async function previewEdits(edits: SemanticEdit[], title: string) {
    if (!workspaceRef.current || lifecycleBusy.current) return;
    const generation = workspaceRef.current.generation;
    setEditBusy(true);
    setError('');
    try {
      await documents.flushAll();
      if (lifecycleBusy.current || workspaceRef.current?.generation !== generation) return;
      const next = await api.previewEdit(edits, generation);
      if (lifecycleBusy.current || workspaceRef.current?.generation !== generation) return;
      setEditTitle(title);
      setEditPreview(next);
      setRename(false);
      setCodeActions(null);
    } catch (e) {
      report(e);
    } finally {
      setEditBusy(false);
    }
  }
  async function editorAction(action: 'format' | 'rename' | 'codeActions', path = focusPath) {
    if (!path) return;
    if (action === 'rename') {
      setError('');
      setRename(true);
      return;
    }
    const result = await editorRequest(action, path, position);
    if (!result) return;
    if (result.state !== 'complete') {
      setError(result.reasons.join('\n') || `${action} is ${result.state}`);
      return;
    }
    if (action === 'codeActions') {
      setCodeActions(result.codeActions ?? []);
      return;
    }
    if (result.edits?.length) await previewEdits(result.edits, 'Format file');
    else setStatus('Formatting is up to date');
  }
  async function renameSymbol(newName: string) {
    if (!focusPath) return;
    setEditBusy(true);
    setError('');
    try {
      const result = await editorRequest('rename', focusPath, position, { newName });
      if (!result || result.state !== 'complete')
        throw new Error(
          result?.reasons.join('\n') || 'Rename did not complete. No edits have been applied.',
        );
      if (!result.edits?.length) throw new Error('No rename edits were returned.');
      await previewEdits(result.edits, `Rename to ${newName}`);
    } catch (e) {
      report(e);
    } finally {
      setEditBusy(false);
    }
  }
  async function applyEdits() {
    if (!editPreview) return;
    setEditBusy(true);
    setError('');
    try {
      await documents.flushAll();
      const snapshots = await api.applyEdit(editPreview.id);
      documents.adoptEdits(snapshots);
      setTabs((current) => [
        ...new Set([...current, ...snapshots.map((snapshot) => snapshot.path)]),
      ]);
      setEditPreview(null);
      setStatus(`Updated ${snapshots.length} editor buffers. Save to write changes to disk.`);
    } catch (e) {
      report(e);
    } finally {
      setEditBusy(false);
    }
  }
  function goHistory(direction: 'back' | 'forward') {
    const target = history.current[direction]();
    if (target)
      void openFile(target.path, target.position, false, focusPane, target.sourceContextId);
  }
  async function search() {
    const id = ++searchId.current;
    setSearching(true);
    setError('');
    try {
      const found = await api.search(searchQuery);
      if (id === searchId.current) setMatches(found);
    } catch (e) {
      if (id === searchId.current) report(e);
    } finally {
      if (id === searchId.current) setSearching(false);
    }
  }
  function updateBreakpoints(path: string, lines: number[], edited = false) {
    setBreakpoints((current) => {
      const previous = current[path] ?? [];
      return previous.length === lines.length &&
        previous.every((line, index) => line === lines[index])
        ? current
        : { ...current, [path]: lines };
    });
    if (edited)
      setCoverageLines((current) => {
        if (!current[path]) return current;
        const next = { ...current };
        delete next[path];
        return next;
      });
  }
  async function showCoverage(report: CoverageReport) {
    latestCoverage.current = report;
    const next: Record<string, { line: number; count: number }[]> = {};
    for (const file of report.files) {
      const doc = documents.documents.get(file.path);
      if (doc && !(await matchesCoverage(doc.state?.doc.toString() ?? doc.initial, file.fileHash)))
        continue;
      next[file.path] = coverageForFile(file);
    }
    if (latestCoverage.current === report) setCoverageLines(next);
  }
  function sidebarVisible(item: SidebarTool, layout = sidebarLayout) {
    return layout.active[layout.placements[item]] === item;
  }
  function changeSidebar(action: SidebarAction, discard = false) {
    if (!workspace || hydratedWorkspace !== workspace.root) return;
    const current = sidebarLayoutRef.current;
    const next =
      action.kind === 'move'
        ? moveSidebarTool(current, action.tool, action.side)
        : action.kind === 'open'
          ? openSidebarTool(current, action.tool)
          : action.kind === 'toggle'
            ? toggleSidebarTool(current, action.tool)
            : closeSidebar(current, action.side);
    if (next === current) return;
    if (
      databaseDirty &&
      sidebarVisible('database', current) &&
      !sidebarVisible('database', next) &&
      !discard
    ) {
      setPendingSidebar(action);
      return;
    }
    if (sidebarVisible('http', next) && !sidebarVisible('http', current)) {
      const doc = focusPath && documents.documents.get(focusPath);
      setHttpSource(
        doc && /\.http$/i.test(focusPath ?? '') ? (doc.state?.doc.toString() ?? doc.initial) : '',
      );
    }
    if (sidebarVisible('git', next)) setGitVisited(true);
    sidebarLayoutRef.current = next;
    setSidebarLayout(next);
    setPendingSidebar(null);
    const root = workspace.root;
    // Ordered writes preserve rapid moves and finish before another workspace opens.
    sidebarWrites.current = sidebarWrites.current
      .then(async () => {
        await api.setSetting(`zwip.${root}.sidebarLayout`, next);
      })
      .catch(report);
    if (action.kind === 'move') {
      setStatus(`${sidebarLabels[action.tool]} moved to the ${action.side} sidebar`);
      requestAnimationFrame(() => {
        if (document.querySelector('dialog[open]')) return;
        document
          .querySelector<HTMLButtonElement>(
            `nav[data-sidebar-side="${action.side}"] [data-sidebar-tool="${action.tool}"]`,
          )
          ?.focus();
      });
    }
  }
  function changeAuxiliary(next: AuxiliaryTool) {
    changeSidebar({ kind: 'open', tool: next });
  }
  function moveTool(item: SidebarTool, side: SidebarSide) {
    changeSidebar({ kind: 'move', tool: item, side });
  }
  function sidebarWidth(side: SidebarSide, value: number) {
    const minimum = sidebarLayout.active[side] === 'project' ? 170 : 320;
    const maximum = Math.max(minimum, window.innerWidth - 350);
    return Math.max(minimum, Math.min(maximum, value));
  }
  function resize(event: React.PointerEvent, direction: 'tree' | 'tools' | 'auxiliary') {
    event.preventDefault();
    const start = direction !== 'tools' ? event.clientX : event.clientY;
    const side = direction === 'tree' ? 'left' : 'right';
    const panel = document.querySelector<HTMLElement>(
      `.sidebar-panel[data-sidebar-side="${side}"]:not([hidden])`,
    );
    const initial =
      direction === 'tools'
        ? toolHeight
        : (panel?.getBoundingClientRect().width ?? (side === 'left' ? treeWidth : auxiliaryWidth));
    const move = (e: PointerEvent) => {
      if (direction === 'tree') setTreeWidth(sidebarWidth('left', initial + e.clientX - start));
      else if (direction === 'tools')
        setToolHeight(
          Math.max(160, Math.min(window.innerHeight - 200, initial - e.clientY + start)),
        );
      else setAuxiliaryWidth(sidebarWidth('right', initial - e.clientX + start));
    };
    const stop = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', stop);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', stop);
  }
  useEffect(() => {
    if (!workspace || hydratedWorkspace !== workspace.root) return;
    const timer = setTimeout(() => {
      void Promise.all([
        api.setSetting(`zwip.${workspace.root}.treeWidth`, treeWidth),
        api.setSetting(`zwip.${workspace.root}.toolHeight`, toolHeight),
        api.setSetting(`zwip.${workspace.root}.tool`, tool),
        api.setSetting(`zwip.${workspace.root}.auxiliaryWidth`, auxiliaryWidth),
        api.setSetting(`zwip.${workspace.root}.breakpoints`, breakpoints),
      ]).catch(report);
    }, 250);
    return () => clearTimeout(timer);
  }, [
    workspace?.root,
    hydratedWorkspace,
    treeWidth,
    toolHeight,
    tool,
    auxiliaryWidth,
    breakpoints,
  ]);
  const actionsRef = useRef({ save, goHistory, shortcuts });
  actionsRef.current = { save, goHistory, shortcuts };
  useEffect(() => {
    const tap = doubleTapRecognizer();
    const key = (event: KeyboardEvent) => {
      // Double-tap shortcuts complete on the second keyup; others match a keydown.
      const doubled = tap(event);
      if (event.type === 'keyup' && !doubled) return;
      if (event.defaultPrevented || document.querySelector('dialog[open]')) return;
      const actions = actionsRef.current;
      const keys = actions.shortcuts;
      const matchesShortcut = (event: KeyboardEvent, shortcut: string) =>
        doubled ? canonicalShortcut(shortcut) === doubled : matchesKeystroke(event, shortcut);
      if (matchesShortcut(event, keys.save)) {
        event.preventDefault();
        void actions.save();
      } else if (matchesShortcut(event, keys.files)) {
        event.preventDefault();
        setShowFiles(true);
      } else if (matchesShortcut(event, keys.symbols)) {
        event.preventDefault();
        setShowSymbols(true);
      } else if (matchesShortcut(event, keys.actions)) {
        event.preventDefault();
        setShowActions(true);
      } else if (matchesShortcut(event, keys.branches)) {
        event.preventDefault();
        if (workspaceRef.current) setShowBranches(true);
      } else if (matchesShortcut(event, keys.search)) {
        event.preventDefault();
        setTool('search');
      } else if (matchesShortcut(event, keys.back)) {
        event.preventDefault();
        actions.goHistory('back');
      } else if (matchesShortcut(event, keys.forward)) {
        event.preventDefault();
        actions.goHistory('forward');
      }
    };
    window.addEventListener('keydown', key);
    window.addEventListener('keyup', key);
    return () => {
      window.removeEventListener('keydown', key);
      window.removeEventListener('keyup', key);
    };
  }, []);
  useEffect(() => {
    if (usagesPopup || navigating) return;
    for (const path of previewDocuments.current)
      if (!tabs.includes(path) && path !== split) void documents.close(path).catch(() => undefined);
    previewDocuments.current.clear();
  }, [usagesPopup, navigating, tabs, split]);
  const diffView = diffTabs.find((item) => item.path === activeDiff);
  const mainDoc = active ? documents.documents.get(active) : undefined;
  const splitDoc = split ? documents.documents.get(split) : undefined;
  const branchChanged = useCallback((name: string) => setBranch(name), []);
  const commands: ActionCommand[] = [
    { id: 'open', label: 'Open project…', run: () => void chooseWorkspace() },
    {
      id: 'open-new-window',
      label: 'Open project in new window…',
      run: () => void chooseWorkspace(true),
    },
    {
      id: 'new-window',
      label: 'New window',
      shortcut: '⇧⌘N',
      run: () => void newWindow().catch(report),
    },
    {
      id: 'files',
      label: 'Go to file',
      shortcut: shortcutLabel(shortcuts.files),
      disabled: !workspace,
      run: () => setShowFiles(true),
    },
    {
      id: 'symbols',
      label: 'Go to symbol',
      shortcut: shortcutLabel(shortcuts.symbols),
      disabled: !workspace,
      run: () => setShowSymbols(true),
    },
    {
      id: 'branches',
      label: 'Git branches',
      shortcut: shortcutLabel(shortcuts.branches),
      disabled: !workspace,
      run: () => setShowBranches(true),
    },
    {
      id: 'markdown-preview',
      label: markdownPreview ? 'Hide Markdown preview' : 'Show Markdown preview',
      disabled: !active || !isMarkdownPath(active),
      run: () => setMarkdownPreview((current) => !current),
    },
    {
      id: 'save',
      label: 'Save file',
      shortcut: shortcutLabel(shortcuts.save),
      disabled: !focusPath,
      run: () => void save(),
    },
    {
      id: 'save-all',
      label: 'Save all files',
      disabled: !workspace,
      run: () => {
        documents.saveAll().catch(report);
      },
    },
    {
      id: 'find',
      label: 'Find text in workspace',
      shortcut: shortcutLabel(shortcuts.search),
      disabled: !workspace,
      run: () => setTool('search'),
    },
    ...Object.entries(titles).map(([operation, title]) => ({
      id: operation,
      label: `Navigate: ${title}`,
      disabled: !focusPath,
      run: () => void navigate(operation as NavigationOperation),
    })),
    {
      id: 'format',
      label: 'Format current file',
      shortcut: shortcutLabel(shortcuts.format),
      disabled: !focusPath,
      run: () => void editorAction('format'),
    },
    {
      id: 'rename',
      label: 'Rename symbol',
      shortcut: shortcutLabel(shortcuts.rename),
      disabled: !focusPath,
      run: () => void editorAction('rename'),
    },
    {
      id: 'fixes',
      label: 'Show quick fixes and code actions',
      shortcut: shortcutLabel(shortcuts.fixes),
      disabled: !focusPath,
      run: () => void editorAction('codeActions'),
    },
    {
      id: 'git',
      label: 'Git: review changes',
      disabled: !workspace,
      run: () => changeAuxiliary('git'),
    },
    {
      id: 'terminal',
      label: 'Open terminal',
      disabled: !workspace,
      run: () => {
        setTerminalOpen(true);
        setTool('terminal');
      },
    },
    {
      id: 'run',
      label: 'Run a workspace command',
      disabled: !workspace,
      run: () => setTool('run'),
    },
    { id: 'history', label: 'Local History', disabled: !focusPath, run: () => setTool('history') },
    {
      id: 'go',
      label: 'Go: run, test, coverage, and debug',
      disabled: !workspace,
      run: () => {
        setConfiguredGoTarget(undefined);
        setGoOpen(true);
        setTool('go');
      },
    },
    {
      id: 'database',
      label: 'Open database tools',
      disabled: !workspace,
      run: () => changeAuxiliary('database'),
    },
    {
      id: 'http',
      label: 'Open HTTP client with current request file',
      disabled: !workspace,
      run: () => changeAuxiliary('http'),
    },
    {
      id: 'packages',
      label: 'Manage language and tool packages',
      run: () => setShowPackages(true),
    },
    {
      id: 'settings',
      label: 'Settings: shortcuts, appearance, and Local History',
      run: () => setShowSettings(true),
    },
    { id: 'whats-new', label: 'What’s new: update history', run: () => setShowWhatsNew(true) },
    { id: 'theme', label: dark ? 'Use light theme' : 'Use dark theme', run: () => setDark(!dark) },
  ];
  return (
    <div className="ide">
      <header className="topbar">
        <button
          className="project-button"
          onClick={() => void chooseWorkspace()}
          disabled={opening}
        >
          <span className="app-mark">Z</span>
          <strong>{workspace?.name || 'Zwip'}</strong>
          <Icon name="chevron" />
        </button>
        {workspace && (
          <>
            <span className="topbar-divider" />
            <button className="branch-button" onClick={() => changeAuxiliary('git')}>
              <Icon name="branch" />
              {branch || 'Git'}
            </button>
          </>
        )}
        <div className="spacer" />
        {workspace && (
          <>
            <button
              className="icon-button"
              aria-label="Navigation back"
              title={`Back (${shortcutLabel(shortcuts.back)})`}
              onClick={() => goHistory('back')}
            >
              <Icon name="back" />
            </button>
            <button
              className="icon-button"
              aria-label="Navigation forward"
              title={`Forward (${shortcutLabel(shortcuts.forward)})`}
              onClick={() => goHistory('forward')}
            >
              <Icon name="forward" />
            </button>
            <select
              className="run-configuration-select"
              aria-label="Run configuration"
              value={workspaceTasks.state.settings.selectedId ?? ''}
              disabled={!workspaceTasks.state.ready || workspaceTasks.state.saving}
              onChange={(event) => void workspaceTasks.session.select(event.target.value || null)}
            >
              <option value="">Workspace command…</option>
              {workspaceTasks.state.settings.configurations.map((config) => (
                <option key={config.id} value={config.id}>
                  {config.name}
                </option>
              ))}
            </select>
            <button
              aria-label="Run selected configuration"
              disabled={
                workspaceTasks.state.saving ||
                workspaceTasks.state.starting ||
                workspaceTasks.state.task?.running
              }
              onClick={() => {
                setTool('run');
                void workspaceTasks.session.runSelected();
              }}
            >
              <Icon name="play" />
              Run
            </button>
            <button
              aria-label="Debug selected configuration"
              title={
                selectedRunConfiguration?.debug
                  ? `Debug '${selectedRunConfiguration.name}'`
                  : 'Debug needs a run configuration with a Go target'
              }
              disabled={
                !selectedRunConfiguration?.debug ||
                workspaceTasks.state.saving ||
                workspaceTasks.state.starting
              }
              onClick={() => debugSelectedConfiguration()}
            >
              <Icon name="bug" />
              Debug
            </button>
            <button
              className="icon-button"
              aria-label="Database tools"
              title="Database tools"
              aria-pressed={sidebarVisible('database')}
              onClick={() => changeSidebar({ kind: 'toggle', tool: 'database' })}
            >
              <Icon name="database" />
            </button>
            <button
              className="icon-button"
              aria-label="HTTP client"
              title="HTTP client"
              aria-pressed={sidebarVisible('http')}
              onClick={() => changeSidebar({ kind: 'toggle', tool: 'http' })}
            >
              <Icon name="http" />
            </button>
            <button className="global-search" onClick={() => setShowFiles(true)}>
              <Icon name="search" />
              Go to file<kbd>{shortcutLabel(shortcuts.files)}</kbd>
            </button>
          </>
        )}
        <button
          className="icon-button"
          aria-label="Manage packages"
          title="Language & tool packages"
          onClick={() => setShowPackages(true)}
        >
          <Icon name="package" />
        </button>
        <button
          className="icon-button"
          aria-label={dark ? 'Use light theme' : 'Use dark theme'}
          onClick={() => setDark(!dark)}
        >
          <Icon name={dark ? 'sun' : 'moon'} />
        </button>
      </header>
      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}>
            <Icon name="close" />
          </button>
        </div>
      )}
      {!workspace ? (
        <main className="welcome">
          <div className="welcome-inner">
            <div className="welcome-brand">
              <span className="app-mark large">Z</span>
              <div>
                <h1>Zwip</h1>
                <p>Modern lean IDE for faster productivity.</p>
              </div>
            </div>
            <button
              className="primary open-project"
              onClick={() => void chooseWorkspace()}
              disabled={opening}
            >
              <Icon name="folder" />
              {opening ? 'Opening workspace…' : 'Open project…'}
            </button>
            {recentRoots.length > 0 && (
              <div className="recent-projects">
                <h2>Recent projects</h2>
                {recentRoots.map((root) => (
                  <button
                    key={root}
                    disabled={opening}
                    title="⌘-click opens it in a new window"
                    onClick={(event) =>
                      void (event.metaKey ? newWindow(root).catch(report) : loadWorkspace(root))
                    }
                  >
                    <Icon name="folder" />
                    <span>
                      <strong>{root.split('/').pop()}</strong>
                      <small>{root}</small>
                    </span>
                    <Icon name="chevron" />
                  </button>
                ))}
              </div>
            )}
            <p className="welcome-note">
              Add Go, web, and developer tools through{' '}
              <button className="text-button" onClick={() => setShowPackages(true)}>
                packages
              </button>
              .
            </p>
            {!('__TAURI_INTERNALS__' in window) && (
              <p className="inline-notice">
                Desktop services are available in the native app. Start it with{' '}
                <code>npm run dev</code>.
              </p>
            )}
          </div>
        </main>
      ) : (
        <div className="workspace-layout">
          {(['left', 'right'] as const).map((side) => (
            <SidebarRail
              key={side}
              side={side}
              tools={sidebarTools.filter((item) => sidebarLayout.placements[item] === side)}
              active={sidebarLayout.active[side]}
              disabled={hydratedWorkspace !== workspace.root}
              onToggle={(item) => changeSidebar({ kind: 'toggle', tool: item })}
              onMove={moveTool}
            />
          ))}
          {/* Stable keyed hosts keep drafts and tree state intact when their visual order changes. */}
          {sidebarTools.map((item) => {
            const side = sidebarLayout.placements[item];
            const visible = sidebarVisible(item);
            const mounted = item === 'project' || (item === 'git' ? gitVisited : visible);
            if (!mounted) return null;
            return (
              <aside
                key={`${workspace.root}:${item}`}
                id={`sidebar-panel-${item}`}
                className={`sidebar-panel ${item === 'project' ? 'project-panel' : 'auxiliary-panel'}`}
                aria-label={`${sidebarLabels[item]} tool window`}
                data-sidebar-side={side}
                hidden={!visible}
                style={{
                  width: sidebarWidth(side, side === 'left' ? treeWidth : auxiliaryWidth),
                  order: side === 'left' ? 1 : 5,
                }}
              >
                <div className="panel-title">
                  <strong>{sidebarLabels[item]}</strong>
                  {item === 'project' ? (
                    <>
                      <span>{workspace.name}</span>
                      <FileActions
                        root={workspace.root}
                        activePath={focusPath}
                        beforeMutation={() => documents.flushAll()}
                        onApplied={fileActionApplied}
                      />
                      <button
                        className="icon-button"
                        aria-label="Refresh project"
                        onClick={() => {
                          api
                            .refreshWorkspace()
                            .then((next) => {
                              setWorkspace(next);
                              setStatus('Project refreshed');
                            })
                            .catch(report);
                        }}
                      >
                        <Icon name="refresh" />
                      </button>
                    </>
                  ) : (
                    <div className="spacer" />
                  )}
                  <SidebarMoveButton
                    tool={item}
                    side={side}
                    onMove={moveTool}
                    disabled={hydratedWorkspace !== workspace.root}
                  />
                  <button
                    className="icon-button"
                    aria-label={`Close ${sidebarLabels[item]} tool`}
                    title={`Close ${sidebarLabels[item]}`}
                    onClick={() => changeSidebar({ kind: 'close', side })}
                  >
                    <Icon name="close" />
                  </button>
                </div>
                {item === 'project' ? (
                  <ProjectTree
                    files={workspace.files}
                    directories={workspace.directories}
                    ignoredFiles={workspace.ignoredFiles}
                    ignoredDirectories={workspace.ignoredDirectories}
                    excludedDirectories={workspace.excludedDirectories}
                    root={workspace.root}
                    active={focusPath}
                    onOpen={(path) => void openFile(path)}
                    onExclude={(path, excluded) => void setDirectoryExcluded(path, excluded)}
                  />
                ) : (
                  <Suspense fallback={<p className="empty-note">Opening tools…</p>}>
                    {item === 'git' ? (
                      <GitPanel
                        generation={workspace.generation}
                        onBranch={branchChanged}
                        revision={gitRevision}
                        onOpenDiff={openDiff}
                        selected={gitSelection}
                        onSelectedChange={setGitSelection}
                      />
                    ) : item === 'database' ? (
                      <DatabasePanel onDirty={setDatabaseDirty} />
                    ) : (
                      <HttpPanel source={httpSource} />
                    )}
                  </Suspense>
                )}
              </aside>
            );
          })}
          {(['left', 'right'] as const).map(
            (side) =>
              sidebarLayout.active[side] && (
                <div
                  key={`resize-${side}`}
                  className="resize-handle vertical"
                  role="separator"
                  style={{ order: side === 'left' ? 2 : 4 }}
                  aria-label={`Resize ${side} sidebar`}
                  aria-orientation="vertical"
                  tabIndex={0}
                  onPointerDown={(event) => resize(event, side === 'left' ? 'tree' : 'auxiliary')}
                  onKeyDown={(event) => {
                    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                    event.preventDefault();
                    const delta =
                      (event.key === 'ArrowRight' ? 16 : -16) * (side === 'left' ? 1 : -1);
                    if (side === 'left') setTreeWidth((width) => sidebarWidth(side, width + delta));
                    else setAuxiliaryWidth((width) => sidebarWidth(side, width + delta));
                  }}
                />
              ),
          )}
          <main className="workspace-main" style={{ order: 3 }}>
            <div className="editor-tabs" role="tablist" aria-label="Open files">
              {tabs.map((path) => (
                <div
                  className={`editor-tab ${path === active && !diffView ? 'active' : ''}`}
                  key={path}
                >
                  <button
                    role="tab"
                    aria-selected={path === active && !diffView}
                    title={path}
                    onClick={() => {
                      setActive(path);
                      setActiveDiff(undefined);
                      setFocusPane('main');
                    }}
                  >
                    <Icon name="file" />
                    {path.split('/').pop()}
                    {documents.documents.get(path)?.session.dirty && (
                      <span className="dirty-dot" aria-label="Unsaved changes" />
                    )}
                  </button>
                  <button
                    className="tab-close"
                    aria-label={`Close ${path.split('/').pop()}`}
                    onClick={() => closeTab(path)}
                  >
                    <Icon name="close" />
                  </button>
                </div>
              ))}
              {diffTabs.map((item) => (
                <div
                  className={`editor-tab ${item.path === activeDiff ? 'active' : ''}`}
                  key={`diff:${item.path}`}
                >
                  <button
                    role="tab"
                    aria-selected={item.path === activeDiff}
                    title={`Changes in ${item.path}`}
                    onClick={() => setActiveDiff(item.path)}
                  >
                    <Icon name="git" />
                    {item.path.split('/').pop()} (changes)
                  </button>
                  <button
                    className="tab-close"
                    aria-label={`Close changes in ${item.path.split('/').pop()}`}
                    onClick={() => closeDiff(item.path)}
                  >
                    <Icon name="close" />
                  </button>
                </div>
              ))}
              <div className="spacer" />
              {active && !diffView && isMarkdownPath(active) && (
                <button
                  className="icon-button"
                  aria-pressed={markdownPreview}
                  aria-label="Toggle Markdown preview"
                  title="Show a live Markdown preview beside the editor"
                  onClick={() => setMarkdownPreview((current) => !current)}
                >
                  <Icon name="eye" />
                </button>
              )}
              {active && !diffView && (
                <button
                  className="icon-button"
                  aria-label={split ? 'Close split editor' : 'Split editor'}
                  onClick={() => {
                    setSplit(split ? undefined : active);
                    if (split) setFocusPane('main');
                  }}
                >
                  <Icon name="split" />
                </button>
              )}
            </div>
            {active && !diffView && (
              <div className="breadcrumbs">
                <span>{workspace.name}</span>
                {active
                  .replace(`${workspace.root}/`, '')
                  .split('/')
                  .map((part, index) => (
                    <span key={index}>
                      <Icon name="chevron" />
                      {part}
                    </span>
                  ))}
                <div className="spacer" />
                {focusPath && (
                  <BuildContextSelector
                    path={focusPath}
                    contexts={workspace.contexts}
                    value={documents.documents.get(focusPath)?.sourceContextId}
                    onChange={(context) =>
                      void selectSourceContext(focusPath, context).catch(report)
                    }
                  />
                )}
                <details className="navigation-menu">
                  <summary>Navigate</summary>
                  <div>
                    {(Object.entries(titles) as [NavigationOperation, string][]).map(
                      ([operation, title]) => (
                        <button
                          key={operation}
                          onClick={(e) => {
                            e.currentTarget.closest('details')?.removeAttribute('open');
                            void navigate(operation);
                          }}
                        >
                          {title}
                        </button>
                      ),
                    )}
                    {(['format', 'rename', 'codeActions'] as const).map((action) => (
                      <button
                        key={action}
                        onClick={(e) => {
                          e.currentTarget.closest('details')?.removeAttribute('open');
                          void editorAction(action);
                        }}
                      >
                        {action === 'codeActions'
                          ? 'Quick fixes'
                          : action === 'rename'
                            ? 'Rename…'
                            : 'Format file'}
                      </button>
                    ))}
                    <button
                      onClick={(e) => {
                        e.currentTarget.closest('details')?.removeAttribute('open');
                        setTool('history');
                      }}
                    >
                      Local History
                    </button>
                  </div>
                </details>
              </div>
            )}
            <div className="editors">
              {diffView ? (
                <div className="diff-editor">
                  <div className="diff-editor-body">
                    <PartialDiff
                      diff={diffView}
                      selected={
                        gitSelection.get(diffView.path)?.changes ??
                        (gitSelection.has(diffView.path) ? null : new Set())
                      }
                      onSelect={(ids) => chooseDiffLines(diffView, ids)}
                    />
                  </div>
                </div>
              ) : mainDoc ? (
                <>
                  <div className={`editor-pane ${focusPane === 'main' ? 'focused' : ''}`}>
                    <Suspense fallback={<p className="empty-note">Opening editor…</p>}>
                      <CodeEditor
                        shortcuts={shortcuts}
                        breakpoints={breakpoints[mainDoc.session.path]}
                        coverage={coverageLines[mainDoc.session.path]}
                        executionLine={
                          execution?.path === mainDoc.session.path ? execution.line : null
                        }
                        onBreakpoints={(lines, edited) =>
                          updateBreakpoints(mainDoc.session.path, lines, edited)
                        }
                        blame={blame[mainDoc.session.path] ?? null}
                        stickyLines={stickyLines}
                        onCopyReference={(line) => copyReference(mainDoc.session.path, line)}
                        onContextMenu={(x, y, view) =>
                          setEditorMenu({ x, y, view, path: mainDoc.session.path })
                        }
                        document={mainDoc}
                        dark={dark}
                        readOnly={!mainDoc.session.path.startsWith(`${workspace.root}/`)}
                        onNavigate={(operation, at) => void navigate(operation, at, active)}
                        onPosition={setPosition}
                        onFocus={() => setFocusPane('main')}
                        onRequest={(operation, at) =>
                          editorRequest(operation, mainDoc.session.path, at)
                        }
                        onApplyEdits={(edits, title) => void previewEdits(edits, title)}
                        onAction={(action) => void editorAction(action, active)}
                        onSave={() => void save(active)}
                      />
                    </Suspense>
                  </div>
                  {splitDoc && (
                    <div
                      className={`editor-pane secondary ${focusPane === 'split' ? 'focused' : ''}`}
                    >
                      <div className="split-heading">{split?.split('/').pop()}</div>
                      <Suspense fallback={<p className="empty-note">Opening editor…</p>}>
                        <CodeEditor
                          shortcuts={shortcuts}
                          breakpoints={breakpoints[splitDoc.session.path]}
                          coverage={coverageLines[splitDoc.session.path]}
                          executionLine={
                            execution?.path === splitDoc.session.path ? execution.line : null
                          }
                          onBreakpoints={(lines, edited) =>
                            updateBreakpoints(splitDoc.session.path, lines, edited)
                          }
                          blame={blame[splitDoc.session.path] ?? null}
                          stickyLines={stickyLines}
                          onCopyReference={(line) => copyReference(splitDoc.session.path, line)}
                          onContextMenu={(x, y, view) =>
                            setEditorMenu({ x, y, view, path: splitDoc.session.path })
                          }
                          document={splitDoc}
                          dark={dark}
                          readOnly={!splitDoc.session.path.startsWith(`${workspace.root}/`)}
                          onNavigate={(operation, at) => void navigate(operation, at, split)}
                          onPosition={setPosition}
                          onFocus={() => setFocusPane('split')}
                          onRequest={(operation, at) =>
                            editorRequest(operation, splitDoc.session.path, at)
                          }
                          onApplyEdits={(edits, title) => void previewEdits(edits, title)}
                          onAction={(action) => void editorAction(action, split)}
                          onSave={() => void save(split)}
                        />
                      </Suspense>
                    </div>
                  )}
                  {markdownPreview && mainDoc && isMarkdownPath(mainDoc.session.path) && (
                    <div className="editor-pane secondary">
                      <div className="split-heading">
                        Preview · {mainDoc.session.path.split('/').pop()}
                      </div>
                      <MarkdownPreview key={mainDoc.session.path} document={mainDoc} />
                    </div>
                  )}
                </>
              ) : (
                <div className="editor-empty">
                  <span className="app-mark muted-mark">Z</span>
                  <p>Open a file to start editing</p>
                  <button onClick={() => setShowFiles(true)}>
                    Go to file <kbd>{shortcutLabel(shortcuts.files)}</kbd>
                  </button>
                  <span>
                    Navigate with ⌘Click · Find usages with {shortcutLabel(shortcuts.usages)}
                  </span>
                </div>
              )}
            </div>
            {(tool || terminalOpen || goOpen) && (
              <>
                <div
                  style={{ display: tool ? undefined : 'none' }}
                  className="resize-handle horizontal"
                  role="separator"
                  aria-label="Resize tool panel"
                  aria-orientation="horizontal"
                  tabIndex={0}
                  onPointerDown={(e) => resize(e, 'tools')}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowUp')
                      setToolHeight((h) => Math.min(window.innerHeight - 200, h + 16));
                    if (e.key === 'ArrowDown') setToolHeight((h) => Math.max(160, h - 16));
                  }}
                />
                <div
                  className="tool-content"
                  style={{ height: tool ? toolHeight : 0, display: tool ? undefined : 'none' }}
                >
                  {terminalOpen && (
                    <div
                      className="terminal-container"
                      style={{ display: tool === 'terminal' ? 'flex' : 'none' }}
                    >
                      <Suspense fallback={<p className="empty-note">Opening terminal…</p>}>
                        <TerminalPanel
                          visible={tool === 'terminal'}
                          dark={dark}
                          onClose={() => {
                            setTerminalOpen(false);
                            setTool(null);
                          }}
                        />
                      </Suspense>
                    </div>
                  )}
                  {goOpen && (
                    <div
                      className="go-tools-container"
                      style={{ display: tool === 'go' ? 'flex' : 'none' }}
                    >
                      <Suspense fallback={<p className="empty-note">Opening Go tools…</p>}>
                        <GoTools
                          contexts={workspace.contexts}
                          configuredTarget={configuredGoTarget}
                          runConfigurations={workspaceTasks.state.settings.configurations}
                          root={workspace.root}
                          path={focusPath}
                          breakpoints={breakpoints}
                          beforeStart={() => documents.flushAll()}
                          onCoverage={(report) => {
                            void showCoverage(report).catch((e) => setStatus(asError(e).message));
                          }}
                          onOpen={(path, position) => void openFile(path, position)}
                          onExecution={setExecution}
                          onClose={() => {
                            setGoOpen(false);
                            setConfiguredGoTarget(undefined);
                            setTool(null);
                          }}
                        />
                      </Suspense>
                    </div>
                  )}
                  {tool === 'usages' &&
                    (['typeHierarchy', 'incomingCalls', 'outgoingCalls'].includes(
                      navigationOperation,
                    ) ? (
                      <HierarchyTree
                        key={batch?.id ?? 'empty'}
                        batch={batch}
                        operation={navigationOperation as HierarchyOperation}
                        title={navigationTitle}
                        loading={navigating}
                        onExpand={expandHierarchy}
                        onOpen={(location) =>
                          void openFile(
                            location.path,
                            location.range.start,
                            true,
                            focusPane,
                            location.contextIds[0],
                          )
                        }
                        onCancel={cancelNavigation}
                      />
                    ) : (
                      <NavigationResults
                        batch={batch}
                        title={navigationTitle}
                        loading={navigating}
                        onOpen={(location) =>
                          void openFile(
                            location.path,
                            location.range.start,
                            true,
                            focusPane,
                            location.contextIds[0],
                            location.range.end,
                          )
                        }
                        onCancel={cancelNavigation}
                      />
                    ))}
                  {tool === 'problems' && (
                    <section className="results-panel" aria-label="Problems">
                      <div className="results-summary">
                        <strong>Problems</strong>
                        <span>Diagnostics for opened files</span>
                      </div>
                      <div className="results-list">
                        {[...diagnostics].flatMap(([path, items]) =>
                          items.map((item, index) => (
                            <button
                              key={`${path}:${index}`}
                              className="search-match"
                              onClick={() => void openFile(path, item.range.start)}
                            >
                              <span>
                                {item.severity} · {path.split('/').pop()}:
                                {item.range.start.line + 1}
                              </span>
                              <span>{item.message}</span>
                            </button>
                          )),
                        )}
                        {![...diagnostics.values()].some((items) => items.length) && (
                          <p className="empty-note">
                            No diagnostics reported by enabled language packages.
                          </p>
                        )}
                      </div>
                    </section>
                  )}
                  {tool === 'run' && (
                    <TaskPanel
                      session={workspaceTasks.session}
                      state={workspaceTasks.state}
                      onImport={() => setShowRunImport(true)}
                    />
                  )}
                  {tool === 'history' &&
                    (focusPath ? (
                      <HistoryPanel
                        path={focusPath}
                        onRestore={(content) => {
                          const doc = documents.documents.get(focusPath);
                          const view = doc && [...doc.views][0];
                          if (view) {
                            view.dispatch({
                              changes: { from: 0, to: view.state.doc.length, insert: content },
                            });
                            setStatus('Revision restored to editor. Save to write it to disk.');
                          }
                        }}
                      />
                    ) : (
                      <p className="empty-note">Open a file to inspect Local History.</p>
                    ))}
                  {tool === 'search' && (
                    <section className="search-panel">
                      <form
                        className="task-command"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void search();
                        }}
                      >
                        <Icon name="search" />
                        <input
                          autoFocus
                          aria-label="Search text in workspace"
                          placeholder="Search workspace text…"
                          value={searchQuery}
                          onChange={(e) => setSearchQuery(e.target.value)}
                        />
                        <button disabled={searching || !searchQuery.trim()}>
                          {searching ? 'Searching…' : 'Find'}
                        </button>
                        <span>{matches.length} matches</span>
                      </form>
                      <div className="results-list">
                        {matches.map((match, index) => (
                          <button
                            className="search-match"
                            key={`${match.path}:${index}`}
                            onClick={() =>
                              void openFile(match.path, { line: match.line, character: 0 })
                            }
                          >
                            <span>
                              {match.path.replace(`${workspace.root}/`, '')}:{match.line + 1}
                            </span>
                            <code>{match.text}</code>
                          </button>
                        ))}
                      </div>
                    </section>
                  )}
                </div>
              </>
            )}
            <nav className="tool-tabs" aria-label="Tool windows">
              {(['usages', 'search', 'problems', 'terminal', 'run', 'go', 'history'] as Tool[]).map(
                (item) => (
                  <button
                    key={item}
                    className={tool === item ? 'active' : ''}
                    aria-pressed={tool === item}
                    onClick={() => {
                      if (item === 'terminal') setTerminalOpen(true);
                      if (item === 'go') setGoOpen(true);
                      setTool(tool === item ? null : item);
                    }}
                  >
                    <Icon
                      name={
                        item === 'run' || item === 'terminal'
                          ? 'terminal'
                          : item === 'history'
                            ? 'clock'
                            : 'search'
                      }
                    />
                    {item === 'go'
                      ? 'Go tools'
                      : item === 'usages'
                        ? 'Usages'
                        : item === 'history'
                          ? 'Local History'
                          : item[0].toUpperCase() + item.slice(1)}
                  </button>
                ),
              )}
              <div className="spacer" />
              {tool && (
                <button
                  className="icon-button"
                  aria-label="Hide tool window"
                  onClick={() => setTool(null)}
                >
                  <Icon name="close" />
                </button>
              )}
            </nav>
          </main>
        </div>
      )}
      <footer className="statusbar">
        <span className={`status-dot ${navigating || opening ? 'busy' : ''}`} />
        <span role="status">{navigating ? 'Searching semantic contexts…' : status}</span>
        <div className="spacer" />
        <IndexingStatus
          scannedFiles={scannedFiles}
          contexts={workspace?.contexts ?? []}
          root={workspace?.root}
        />
        {focusPath && (
          <>
            <span>
              {position.line + 1}:{position.character + 1}
            </span>
            <span>UTF-8</span>
            <span>
              {documents.documents.get(focusPath)?.session.error
                ? 'Sync failed · buffer retained'
                : documents.documents.get(focusPath)?.session.dirty
                  ? 'Modified'
                  : 'Saved'}
            </span>
          </>
        )}
        <button onClick={() => setShowSettings(true)}>Settings</button>
        {workspace && (
          <button onClick={() => setShowContexts(true)}>
            {workspace.contexts.filter((context) => context.state === 'ready').length}/
            {workspace.contexts.length} contexts ready
          </button>
        )}
        {workspace && <button onClick={() => setShowRecovery(true)}>Recovery</button>}
        <button onClick={() => setShowPackages(true)}>Packages</button>
        <button aria-label="What’s new" onClick={() => setShowWhatsNew(true)}>
          What’s new{hasNewUpdates && <span className="update-new">New</span>}
        </button>
      </footer>
      {showWhatsNew && <WhatsNew onClose={closeWhatsNew} />}
      {showContexts && workspace && (
        <Modal title="Workspace analysis coverage" onClose={() => setShowContexts(false)}>
          <div className="modal-body">
            <p>
              Language packages activate when you use their tools. Loading or failed contexts remain
              visible in semantic search coverage.
            </p>
            <div style={{ maxHeight: 400, overflow: 'auto' }}>
              {workspace.contexts.map((context) => (
                <p key={context.id}>
                  <strong>{context.id}</strong> · {context.state}
                  {context.reason && <> — {context.reason}</>}
                </p>
              ))}
            </div>
          </div>
        </Modal>
      )}
      {showRecovery && workspace && (
        <Recovery
          root={workspace.root}
          onClose={() => setShowRecovery(false)}
          onOpen={(path) => {
            setShowRecovery(false);
            void openFile(path);
          }}
        />
      )}
      {pendingSidebar && (
        <Modal title="Discard pending row edits?" onClose={() => setPendingSidebar(null)}>
          <div className="modal-body">
            <p>Your database edits have not been applied. Closing this tool will discard them.</p>
          </div>
          <div className="modal-actions">
            <button onClick={() => setPendingSidebar(null)}>Keep editing</button>
            <button className="danger" onClick={() => changeSidebar(pendingSidebar, true)}>
              Discard and close
            </button>
          </div>
        </Modal>
      )}
      {showSymbols && workspace && (
        <SymbolSearch
          key={workspace.generation}
          onSearch={searchSymbols}
          onChoose={(location) => {
            setShowSymbols(false);
            void openFile(
              location.path,
              location.range.start,
              true,
              focusPane,
              location.contextIds[0],
            );
          }}
          onClose={() => setShowSymbols(false)}
        />
      )}
      {showFiles && workspace && (
        <FileSearch
          files={workspace.files}
          recent={recentFiles}
          onOpen={(path) => {
            setShowFiles(false);
            void openFile(path);
          }}
          onClose={() => setShowFiles(false)}
        />
      )}
      {editPreview && (
        <EditPreview
          preview={editPreview}
          title={editTitle}
          error={error}
          busy={editBusy}
          onApply={() => void applyEdits()}
          onClose={() => setEditPreview(null)}
        />
      )}
      {rename && !editPreview && (
        <RenameDialog
          error={error}
          busy={editBusy}
          onRename={(name) => void renameSymbol(name)}
          onClose={() => setRename(false)}
        />
      )}
      {codeActions && (
        <Modal title="Quick fixes and code actions" onClose={() => setCodeActions(null)}>
          <div className="modal-body">
            {codeActions.map((action, index) => (
              <button
                className="action-row"
                key={index}
                onClick={() => void previewEdits(action.edits, action.title)}
              >
                {action.title}
              </button>
            ))}
            {!codeActions.length && (
              <p className="empty-note">No code actions are available here.</p>
            )}
          </div>
        </Modal>
      )}
      {showBranches && workspace && (
        <BranchPopup
          onClose={() => setShowBranches(false)}
          onChanged={(change) => {
            setBranch(change.branch);
            setGitRevision((value) => value + 1);
            setStatus(
              change.conflicts
                ? `${change.message} Conflicts need resolving in the Git panel.`
                : change.message,
            );
            if (change.conflicts) changeAuxiliary('git');
          }}
        />
      )}
      {showRunImport && workspace && (
        <IntelliJImport
          runOnly
          shortcuts={shortcuts}
          workspaceRoot={workspace.root}
          runSession={workspaceTasks.session}
          onClose={() => setShowRunImport(false)}
        />
      )}
      {showSettings && (
        <Settings
          shortcuts={shortcuts}
          workspaceRoot={workspace?.root}
          runSession={workspace ? workspaceTasks.session : undefined}
          excludedDirectories={workspace?.excludedDirectories}
          onInclude={(path) => setDirectoryExcluded(path, false)}
          history={historyPreferences}
          dark={dark}
          stickyLines={stickyLines}
          onStickyLines={changeStickyLines}
          onTheme={setDark}
          onSave={async (keys, history) => {
            await api.setSetting('history', history);
            await api.setSetting('shortcuts', keys);
            setShortcuts(keys);
            setHistoryPreferences(history);
          }}
          onClose={() => setShowSettings(false)}
        />
      )}
      {editorMenu && (
        <EditorContextMenu
          x={editorMenu.x}
          y={editorMenu.y}
          entries={editorMenuEntries(editorMenu.view, editorMenu.path)}
          onClose={() => setEditorMenu(null)}
        />
      )}
      {showActions && <CommandSearch commands={commands} onClose={() => setShowActions(false)} />}
      {showPackages && <Packages onClose={() => setShowPackages(false)} />}
      {targets && (
        <TargetChooser
          locations={targets}
          onClose={() => setTargets(null)}
          onChoose={(location) => {
            setTargets(null);
            void openFile(
              location.path,
              location.range.start,
              true,
              focusPane,
              location.contextIds[0],
              location.range.end,
            );
          }}
        />
      )}
      {usagesPopup && (
        <UsagesPopup
          anchor={usagesPopup.anchor}
          symbol={usagesPopup.symbol}
          workspaceRoot={workspace?.root}
          batch={batch}
          loading={navigating}
          dark={dark}
          loadPreview={async (path) => {
            const doc = await documents.open(path);
            previewDocuments.current.add(path);
            return doc.state?.doc.toString() ?? doc.initial;
          }}
          onNavigate={(path, at) => void navigate('smart', at, path)}
          onOpen={(location) => {
            setUsagesPopup(null);
            void openFile(
              location.path,
              location.range.start,
              true,
              focusPane,
              location.contextIds[0],
              location.range.end,
            );
          }}
          onDock={() => {
            setUsagesPopup(null);
            setTool('usages');
          }}
          onClose={() => setUsagesPopup(null)}
        />
      )}
      {closePath && (
        <Modal title="Save changes before closing?" onClose={() => setClosePath(undefined)}>
          <div className="modal-body">
            <p>{closePath.split('/').pop()} has unsaved changes.</p>
          </div>
          <div className="modal-actions">
            <button onClick={() => setClosePath(undefined)}>Keep editing</button>
            <button
              className="primary"
              onClick={() => {
                const path = closePath;
                documents.documents
                  .get(path)
                  ?.session.save()
                  .then(() => removeTab(path))
                  .catch(report);
              }}
            >
              Save and close
            </button>
          </div>
        </Modal>
      )}
      {pendingRoot && (
        <Modal title="Save workspace changes?" onClose={() => setPendingRoot(undefined)}>
          <div className="modal-body">
            <p>Save open changes before switching to {pendingRoot.split('/').pop()}.</p>
          </div>
          <div className="modal-actions">
            <button onClick={() => setPendingRoot(undefined)}>Keep editing</button>
            <button
              className="primary"
              onClick={() => {
                const root = pendingRoot;
                documents
                  .saveAll()
                  .then(() => {
                    setPendingRoot(undefined);
                    return loadWorkspace(root);
                  })
                  .catch(report);
              }}
            >
              Save all and open
            </button>
          </div>
        </Modal>
      )}
      {(opening || closing) && (
        <Modal
          title={opening ? 'Opening workspace' : 'Closing editor'}
          dismissible={false}
          onClose={() => {}}
        >
          <div className="modal-body" role="status">
            {opening
              ? scannedFiles
                ? `Indexing files… ${scannedFiles.toLocaleString()}`
                : 'Synchronizing documents and opening the workspace…'
              : 'Synchronizing and releasing the editor…'}
          </div>
        </Modal>
      )}
    </div>
  );
}
