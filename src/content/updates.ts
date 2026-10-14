export const updateKinds = {
  added: 'Added',
  improved: 'Improved',
  fixed: 'Fixed',
  removed: 'Removed',
  maintenance: 'Maintenance',
} as const;

export interface UpdateEntry {
  readonly id: string;
  readonly version: string;
  readonly date: string;
  readonly title: string;
  readonly summary: string;
  readonly changes: readonly {
    readonly type: keyof typeof updateKinds;
    readonly title: string;
    readonly description: string;
  }[];
}

// Newest first. Keep published IDs stable; see docs/update-history.md.
export const updates: readonly [UpdateEntry, ...UpdateEntry[]] = [
  {
    id: '2026-10-14-branch-actions-flyout',
    version: '0.1.0',
    date: '2026-10-14',
    title: 'Branch actions beside the popup',
    summary: 'The branch action menu opens outside the Git Branches popup.',
    changes: [
      {
        type: 'improved',
        title: 'Branch action flyout',
        description:
          'Branch actions open in a menu beside the Git Branches popup, level with the branch, so branch names keep their full width. It opens on the left when there is no room on the right.',
      },
    ],
  },
  {
    id: '2026-10-14-multiple-windows',
    version: '0.1.0',
    date: '2026-10-14',
    title: 'Multiple windows',
    summary: 'Open each project in its own window.',
    changes: [
      {
        type: 'added',
        title: 'New window',
        description:
          'File › New Window (⇧⌘N), "Open project in new window…" in Find Action, or ⌘-click a recent project. Each window has its own project, language tools and run tasks. Installing or updating a package restarts its language tools only in the window where you made the change; reopen the project in other windows to use it there.',
      },
      {
        type: 'improved',
        title: 'One window per project',
        description:
          'Opening a project that is already open in another window brings that window forward instead. Settings… opens in the window you are using.',
      },
    ],
  },
  {
    id: '2026-10-14-run-console-and-debugger-permissions',
    version: '0.1.0',
    date: '2026-10-14',
    title: 'Run console progress and debugger fix',
    summary: 'Run shows what it is doing; downloaded packages keep their tools runnable.',
    changes: [
      {
        type: 'improved',
        title: 'Run console',
        description:
          'The Run output starts with the directory and command, shows elapsed time while a build or quiet server prints nothing, and ends with the exit code, as in IntelliJ.',
      },
      {
        type: 'fixed',
        title: 'Debugger permission denied',
        description:
          'Packages installed from the catalog now keep executable files runnable, so Go Run and Debug no longer fail with "permission denied" for the bundled debugger.',
      },
    ],
  },
  {
    id: '2026-10-14-double-shift-and-exclude-fix',
    version: '0.1.0',
    date: '2026-10-14',
    title: 'Double Shift shortcuts and folder exclusion fix',
    summary: 'Record ⇧⇧ for Go to file, and Exclude from search works again.',
    changes: [
      {
        type: 'added',
        title: 'Double-tap shortcuts',
        description:
          'Settings can record a double-tapped Shift, Option, Control or Command, such as ⇧⇧ for Go to file. They work for window actions; editor actions still need a key combination.',
      },
      {
        type: 'fixed',
        title: 'Exclude from search and indexing',
        description:
          'Choosing it in the folder menu now excludes the folder and dims it; the menu closed before the click registered. Failures now show in the status bar.',
      },
    ],
  },
  {
    id: '2026-10-14-intellij-editor-menu-debug-and-package-rename',
    version: '0.1.0',
    date: '2026-10-14',
    title: 'Editor menu, one-click Debug and package rename',
    summary: 'IntelliJ-style right-click menu, Debug next to Run, and more refactoring.',
    changes: [
      {
        type: 'added',
        title: 'Editor right-click menu',
        description:
          'Context actions, cut/copy/paste, Copy Reference (path:line, ⌥⇧⌘C), Find Usages, Refactor › Rename, Folding, Go To, Reformat Code, Run/Debug for the selected configuration and Git › Annotate with Git Blame, grouped as in IntelliJ.',
      },
      {
        type: 'added',
        title: 'Debug next to Run',
        description:
          'The Debug button starts the selected run configuration’s Go target at once. It is disabled for configurations without a Go target.',
      },
      {
        type: 'added',
        title: 'Run configurations in Go tools',
        description:
          'Go tools can import a run configuration: its Go target, working directory, arguments and environment variables. Configurations without a Go target add their working directory and environment to Debug.',
      },
      {
        type: 'added',
        title: 'Rename Go packages',
        description:
          'Renaming a package clause renames the package in place, as GoLand does: package clauses, the external test package and importers update; the directory and import path stay. Requires Go package 0.1.2.',
      },
      {
        type: 'added',
        title: 'Git blame and sticky headers',
        description:
          'Annotate with Git Blame shows author and date beside each committed line. Settings › Appearance can pin the enclosing function header while scrolling long bodies.',
      },
    ],
  },
  {
    id: '2026-10-14-ignored-and-excluded-in-project-tree',
    version: '0.1.0',
    date: '2026-10-14',
    title: 'Ignored and excluded folders in the project tree',
    summary: 'See .idea and other Git-ignored files, and which folders are excluded.',
    changes: [
      {
        type: 'improved',
        title: 'Git-ignored files are listed',
        description:
          'Folders such as .idea that Git ignores now appear in olive, like IntelliJ, and open normally. They stay out of search and indexing.',
      },
      {
        type: 'improved',
        title: 'Excluded folders are visible',
        description:
          'Folders excluded from search and indexing appear dimmed. Their contents are not listed.',
      },
      {
        type: 'improved',
        title: 'Exclusion shows a tick',
        description:
          'The folder menu ticks "Exclude from search and indexing" when a folder is excluded; choosing it again includes the folder. Dependency, build and worktree folders stay excluded.',
      },
    ],
  },
  {
    id: '2026-10-14-go-package-0-1-1',
    version: '0.1.0',
    date: '2026-10-14',
    title: 'Go package 0.1.1',
    summary: 'The Go package now ships the GoLand-style Go colors.',
    changes: [
      {
        type: 'improved',
        title: 'Update from Packages',
        description:
          'Go package 0.1.1 carries the new package, type, receiver and builtin colors. Installed 0.1.0 packages show "Update to 0.1.1" in Packages, and "Previous version" returns to 0.1.0.',
      },
    ],
  },
  {
    id: '2026-10-13-goland-go-highlighting',
    version: '0.1.0',
    date: '2026-10-13',
    title: 'GoLand-style Go colors',
    summary: 'Go code now uses the Darcula colors GoLand shows for packages, types and calls.',
    changes: [
      {
        type: 'improved',
        title: 'Distinct Go roles',
        description:
          'Imported packages, struct and interface types, builtin types such as string and bool, method receivers, function declarations and calls each get their own color. Struct fields and local variables stay plain, and struct tag keys read as text with green values. Package calls are recognized from the file imports, so a local variable that shadows an imported package name is still colored as a package.',
      },
      {
        type: 'improved',
        title: 'Darcula dark scheme',
        description:
          'The dark theme follows IntelliJ Darcula syntax colors for every language. Previews in usages, navigation results and branch diffs use the same Go colors.',
      },
    ],
  },
  {
    id: '2026-10-13-ide-zoom-and-code-font-size',
    version: '0.1.0',
    date: '2026-10-13',
    title: 'IDE zoom and code font size',
    summary: 'Scale the whole IDE for large screens, or just the code in the editor.',
    changes: [
      {
        type: 'added',
        title: 'Zoom the whole IDE',
        description:
          '⌘+ and ⌘− zoom text, icons and layout together; ⌘0 resets. The zoom level is remembered across restarts. Available in the desktop app.',
      },
      {
        type: 'added',
        title: 'Code font size',
        description:
          'Pinch on the trackpad or ⌘-scroll over the editor to change the code font size. The size is remembered and applies to every open editor.',
      },
    ],
  },
  {
    id: '2026-10-13-usage-paths-and-dependency-fixes',
    version: '0.1.0',
    date: '2026-10-13',
    title: 'Usage preview, paths and dependency fixes',
    summary:
      'Preview each usage before opening it, see where it lives, and two security alerts are resolved.',
    changes: [
      {
        type: 'added',
        title: 'Usage preview',
        description:
          'The usages popup shows the selected usage with five lines above and below, highlighted like the editor. ⌘-click inside the preview navigates from there; results open in the editor.',
      },
      {
        type: 'improved',
        title: 'Scrolling usage list',
        description: 'Long usage lists scroll after about eight rows, keeping the preview in view.',
      },
      {
        type: 'improved',
        title: 'Folders in usages',
        description:
          'Each usage shows its workspace folder before the file name, shortened to the first and last folder (services/…/http/handler.go) when the path is long. Hover for the full path.',
      },
      {
        type: 'fixed',
        title: 'Test tooling security update',
        description:
          'The end-to-end test tools no longer include extract-zip, which had unpatched path-traversal advisories. This affects development tooling only, not the app.',
      },
      {
        type: 'maintenance',
        title: 'Cleaner build',
        description: 'Removed a lazy import that had no effect and produced a build warning.',
      },
    ],
  },
  {
    id: '2026-10-13-indexing-progress-per-module',
    version: '0.1.0',
    date: '2026-10-13',
    title: 'Indexing progress per module',
    summary: 'See which modules are still indexing, which are ready and which failed.',
    changes: [
      {
        type: 'added',
        title: 'Per-module indexing list',
        description:
          'Click Indexing in the status bar to list every module with its state and the reason the language package reports, such as queued or in progress. Failed modules show their error.',
      },
    ],
  },
  {
    id: '2026-10-13-makefile-package',
    version: '0.1.0',
    date: '2026-10-13',
    title: 'Makefile package',
    summary:
      'Install the Makefile package for Makefile highlighting and IntelliJ Makefile run configurations.',
    changes: [
      {
        type: 'added',
        title: 'Makefile package',
        description:
          'A new package in Packages highlights Makefile, GNUmakefile, .mk and .mak files. It runs no process of its own.',
      },
      {
        type: 'added',
        title: 'Import Makefile targets',
        description:
          'With the package enabled, IntelliJ Makefile run configurations import as make commands, with their arguments and environment variables.',
      },
      {
        type: 'maintenance',
        title: 'Packages can match file names',
        description:
          'Package grammars can now apply to extensionless files by name, such as Makefile.',
      },
    ],
  },
  {
    id: '2026-10-13-intellij-colors-usages-popup',
    version: '0.1.0',
    date: '2026-10-13',
    title: 'IntelliJ colors and Show Usages popup',
    summary:
      'Code uses IntelliJ colors, single targets open directly and usages appear under the caret.',
    changes: [
      {
        type: 'improved',
        title: 'IntelliJ color schemes',
        description:
          'Editors, the SQL console, usage lists and the branch diff window use the IntelliJ Dark and Light colors for keywords, strings, numbers, comments, functions, fields and constants.',
      },
      {
        type: 'improved',
        title: 'Richer Go highlighting',
        description:
          'Go files distinguish function and method declarations, calls, fields and constants. An installed Go package keeps its own grammar until it is updated to a build that includes this change.',
      },
      {
        type: 'improved',
        title: 'Direct navigation',
        description:
          'When a complete search finds exactly one declaration or implementation, it opens directly with the cursor on the symbol and the line highlighted until you move the cursor.',
      },
      {
        type: 'added',
        title: 'Show Usages popup',
        description:
          'Find Usages opens a popup just below the current line, with colored code previews, keyboard navigation and a button to dock the list in the bottom panel. Incomplete search coverage is still shown.',
      },
    ],
  },
  {
    id: '2026-10-13-run-configuration-environment',
    version: '0.1.0',
    date: '2026-10-13',
    title: 'Environment variables for run configurations',
    summary:
      'Run configurations keep their environment, and many more IntelliJ configurations import.',
    changes: [
      {
        type: 'added',
        title: 'Environment variables',
        description:
          'Each run configuration has an Environment box (NAME=value per line). Values apply to Run and to Debug.',
      },
      {
        type: 'improved',
        title: 'IntelliJ environment import',
        description:
          'Environment values are imported. Values that look like credentials are masked and only imported when you tick them.',
      },
      {
        type: 'improved',
        title: 'Go package configurations',
        description:
          'Go configurations that name a package such as "oscar" now import. Packages in another module are built there and run from the configured working directory; those import Run only.',
      },
      {
        type: 'maintenance',
        title: 'Still manual',
        description:
          'Environment files, Makefile, HTTP request, Docker, remote debug and file-only Go configurations still need manual setup.',
      },
    ],
  },
  {
    id: '2026-10-13-branch-diff-window',
    version: '0.1.0',
    date: '2026-10-13',
    title: 'Side-by-side diff with the working tree',
    summary: 'Show Diff with Working Tree now opens a full diff window instead of a file list.',
    changes: [
      {
        type: 'improved',
        title: 'Diff window for branch comparisons',
        description:
          'Changed files appear in a tree beside a two-pane diff of the branch version and your version, with synchronized scrolling, connector bands, word-level highlights and folded unchanged lines.',
      },
      {
        type: 'added',
        title: 'Difference navigation',
        description:
          'F7 and Shift+F7 move between differences and continue into the next or previous file. Untracked files are still not compared, and code is not syntax highlighted in this view.',
      },
    ],
  },
  {
    id: '2026-10-13-public-registry-lockfile',
    version: '0.1.0',
    date: '2026-10-13',
    title: 'Build fix for Markdown highlighting',
    summary: 'Release builds can download every dependency again.',
    changes: [
      {
        type: 'maintenance',
        title: 'Public package sources',
        description:
          'The Markdown highlighting dependencies now download from the public npm registry, so automated builds no longer time out.',
      },
    ],
  },
  {
    id: '2026-10-13-branch-popup-side-menu',
    version: '0.1.0',
    date: '2026-10-13',
    title: 'Branch popup side menu',
    summary: 'Branch actions open beside the list, and arrow keys work right away.',
    changes: [
      {
        type: 'improved',
        title: 'Side menu for branch actions',
        description:
          'Choosing a branch opens its actions in a side menu, keeping the branch list visible. → opens it, ← or Escape closes it.',
      },
      {
        type: 'fixed',
        title: 'Arrow keys on open',
        description:
          'The search box is focused when the popup opens, so arrow keys move between branches without clicking first.',
      },
    ],
  },
  {
    id: '2026-10-13-package-progress-indexing-settings-menu',
    version: '0.1.0',
    date: '2026-10-13',
    title: 'Package downloads, indexing progress and Settings menu',
    summary:
      'Download packages in place, watch their progress, and see indexing in the status bar.',
    changes: [
      {
        type: 'improved',
        title: 'Download beside Enable',
        description:
          'Each package shows Download, or Update when the catalog has a newer version, next to its Enable button.',
      },
      {
        type: 'added',
        title: 'Install progress',
        description: 'A progress bar shows the download size, then verification and installation.',
      },
      {
        type: 'added',
        title: 'Indexing progress',
        description:
          'The status bar shows files indexed while a workspace opens, then build contexts that are still loading.',
      },
      {
        type: 'added',
        title: 'Settings in the app menu',
        description: 'Open Settings from Zwip → Settings… or with ⌘,.',
      },
    ],
  },
  {
    id: '2026-10-13-diff-viewer',
    version: '0.1.0',
    date: '2026-10-13',
    title: 'Better diff viewer',
    summary: 'Changes open in the main editor with a GitHub-style side-by-side view.',
    changes: [
      {
        type: 'improved',
        title: 'Side-by-side diff',
        description:
          'Removed and added lines now sit on matching rows with their own line numbers, like GitHub. The unified view is unchanged and is the default.',
      },
      {
        type: 'improved',
        title: 'Diffs open in the main editor only',
        description:
          'The Git panel no longer shows a second copy of the diff. Choose hunks or lines for a partial commit from the diff tab; selections now persist while the Git panel is closed.',
      },
      {
        type: 'maintenance',
        title: 'Diff limits',
        description:
          'The diff shows changed hunks with nearby context rather than the whole file, and it has no syntax highlighting or intra-line highlights.',
      },
    ],
  },
  {
    id: '2026-10-13-branch-popup',
    version: '0.1.0',
    date: '2026-10-13',
    title: 'Git branches popup',
    summary: 'Press Cmd+Shift+B to switch branches and run common branch actions.',
    changes: [
      {
        type: 'added',
        title: 'Git branches popup',
        description:
          'Search local and remote branches, create a branch, or open a branch’s actions: checkout (remote branches get a tracking branch), new branch from it, checkout and rebase, compare, diff with the working tree, rebase, merge, update, push, rename and delete. Merge, rebase, update, push and delete ask for confirmation. The shortcut can be changed in Settings.',
      },
      {
        type: 'maintenance',
        title: 'Branch popup limits',
        description:
          'Compare and working-tree diff list changed files only, and checking out a tag or revision is not included. Push never forces, and update only fast-forwards.',
      },
    ],
  },
  {
    id: '2026-10-13-shortcut-recording-and-preview-button',
    version: '0.1.0',
    date: '2026-10-13',
    title: 'Shortcut recording and toolbar fixes',
    summary: 'Recording a shortcut works again, and the editor toolbar is cleaner.',
    changes: [
      {
        type: 'fixed',
        title: 'Shortcut recording',
        description:
          'Choosing a shortcut in Settings now records the next key press. Clicking elsewhere cancels recording.',
      },
      {
        type: 'improved',
        title: 'Markdown preview button',
        description: 'The Preview button is now an eye icon with proper spacing beside Split.',
      },
    ],
  },
  {
    id: '2026-10-13-git-diff-tabs',
    version: '0.1.0',
    date: '2026-10-13',
    title: 'Changes open in the editor',
    summary: 'Selecting a Git change shows its diff in the main editor area.',
    changes: [
      {
        type: 'added',
        title: 'Diff tabs',
        description:
          'Selecting a changed file opens a "(changes)" tab with side-by-side and unified views, highlighted for the file type. Selecting the file again refreshes it.',
      },
      {
        type: 'maintenance',
        title: 'Commit selection is unchanged',
        description:
          'Choose hunks or lines for a partial commit in the Git panel. Diff tabs are read-only and show a snapshot from when the file was selected.',
      },
    ],
  },
  {
    id: '2026-10-13-built-in-highlighting',
    version: '0.1.0',
    date: '2026-10-13',
    title: 'Syntax highlighting for more files',
    summary: 'Code is highlighted even before any language package is enabled.',
    changes: [
      {
        type: 'added',
        title: 'Built-in highlighting',
        description:
          'Go, TypeScript, JavaScript, HTML, CSS, JSON, SQL and Markdown, plus Python, Rust, Ruby, Lua, Swift, C-family, Java, Kotlin, shell, YAML, TOML, diff, Dockerfile and go.mod, are highlighted without packages.',
      },
      {
        type: 'maintenance',
        title: 'Packages still take priority',
        description:
          'Enabled Go and Web packages keep supplying their own grammars. Highlighting is not language intelligence; navigation and diagnostics still need packages.',
      },
    ],
  },
  {
    id: '2026-10-13-run-import-shortcut',
    version: '0.1.0',
    date: '2026-10-13',
    title: 'Import run configurations from the Run panel',
    summary: 'Import IntelliJ run configurations without opening Settings.',
    changes: [
      {
        type: 'added',
        title: 'Import from IntelliJ… in the configuration list',
        description:
          'Choose it at the bottom of the Run panel’s configuration list to review and import run configurations only. Settings import is unchanged.',
      },
    ],
  },
  {
    id: '2026-10-13-ci-test-timeout',
    version: '0.1.0',
    date: '2026-10-13',
    title: 'CI test timeout',
    summary: 'Slow automated tests no longer fail on shared build machines.',
    changes: [
      {
        type: 'maintenance',
        title: 'Longer test timeout',
        description:
          'Tests now allow 30 seconds each. Web editor rename tests took over five seconds on GitHub runners.',
      },
    ],
  },
  {
    id: '2026-10-13-app-icon',
    version: '0.1.0',
    date: '2026-10-13',
    title: 'App icon and favicon',
    summary: 'Zwip now has its own icon in the Dock and browser tab.',
    changes: [
      {
        type: 'added',
        title: 'Application icon',
        description: 'A simple placeholder "Z" icon replaces the default app icon.',
      },
    ],
  },
  {
    id: '2026-10-13-default-package-catalog',
    version: '0.1.0',
    date: '2026-10-13',
    title: 'Packages download without setup',
    summary: 'The Packages dialog now lists installable packages right away.',
    changes: [
      {
        type: 'added',
        title: 'Built-in package catalog',
        description:
          'Go, Web, React/Next, SQL, Redis and HTTP packages can be installed without entering a catalog URL. You can still use your own HTTPS catalog.',
      },
      {
        type: 'maintenance',
        title: 'Packages are checksum-verified',
        description:
          'Downloads must match the catalog checksums but are not separately signed. Packages contain executable code.',
      },
    ],
  },
  {
    id: '2026-10-13-ci-resources',
    version: '0.1.0',
    date: '2026-10-13',
    title: 'CI build fix',
    summary: 'Automated checks now work on a clean checkout.',
    changes: [
      {
        type: 'fixed',
        title: 'CI generated resources',
        description:
          'The check and release workflows now use Rust 1.95.0, download Rust dependencies and generate the bundled notices first, which failed on clean GitHub runners. One Rust style lint was also fixed.',
      },
    ],
  },
  {
    id: '2026-10-13-exclusions-and-markdown-preview',
    version: '0.1.0',
    date: '2026-10-13',
    title: 'Folder exclusions and Markdown preview',
    summary: 'Skip folders in search, and preview Markdown beside the editor as you type.',
    changes: [
      {
        type: 'added',
        title: 'Exclude folders from search and indexing',
        description:
          'Right-click a folder in the project tree to leave it out of file search, text search and language discovery. Excluded folders also disappear from the tree.',
      },
      {
        type: 'added',
        title: 'Excluded folders list',
        description:
          'Settings lists skipped folders and why, and lets you include your own exclusions again. Paths matched by .gitignore are skipped but not listed.',
      },
      {
        type: 'added',
        title: 'Live Markdown preview',
        description:
          'Choose Preview on a Markdown file to see it rendered beside the editor, updating as you type. Raw HTML is not rendered, links do not open, and images are not loaded.',
      },
    ],
  },
  {
    id: '2026-10-13-tree-selection-and-releases',
    version: '0.1.0',
    date: '2026-10-13',
    title: 'Project tree selection and release builds',
    summary: 'Folders no longer look selected, and release builds can be published to GitHub.',
    changes: [
      {
        type: 'fixed',
        title: 'Folders highlighted in the project tree',
        description:
          'All folders appeared selected when no file was open. Only the open file is highlighted now.',
      },
      {
        type: 'maintenance',
        title: 'CI and release workflows',
        description:
          'GitHub Actions now runs checks and tests on pushes and pull requests. Pushing a version tag builds the app and attaches a zipped, ad-hoc-signed Apple Silicon build to a GitHub pre-release; it is not notarized.',
      },
    ],
  },
  {
    id: '2026-10-13-product-language',
    version: '0.1.0',
    date: '2026-10-13',
    title: 'Clearer product descriptions',
    summary: 'Explore Zwip’s features in its own words.',
    changes: [
      {
        type: 'improved',
        title: 'Consistent feature descriptions',
        description:
          'The website, documentation and settings describe navigation, Git workflows and shortcuts directly. Editing behavior, shortcuts and settings import remain unchanged.',
      },
    ],
  },
  {
    id: '2026-10-13-zwip-internals',
    version: '0.1.0',
    date: '2026-10-13',
    title: 'Zwip throughout',
    summary: 'One name across the application, packages and development tools.',
    changes: [
      {
        type: 'maintenance',
        title: 'Consistent project identifiers',
        description:
          'Configuration uses .zwip.json and ZWIP_* environment variables. Package workers, preferences, application identity and development tools now use Zwip names. Repository links point to zwip-ide.',
      },
      {
        type: 'removed',
        title: 'A fresh setup',
        description:
          'Zwip uses fresh application storage. Previous application settings, connections, packages and recovery data are not imported. Set up your workspace and connections again; existing data is left untouched.',
      },
      {
        type: 'fixed',
        title: 'Clean Go package rebuilds',
        description:
          'Rebuilding the Go package removes obsolete build assets so the package remains consistent with its verified file inventory.',
      },
    ],
  },
  {
    id: '2026-10-13-zwip',
    version: '0.1.0',
    date: '2026-10-13',
    title: 'Meet Zwip',
    summary: 'Modern lean IDE for faster productivity.',
    changes: [
      {
        type: 'improved',
        title: 'A new name for your IDE',
        description:
          'The application, website, project packages and documentation carry the Zwip name and Z mark.',
      },
      {
        type: 'maintenance',
        title: 'Your existing workspace stays with you',
        description:
          'Existing settings, saved connections, recovery data and workspace configuration keep their stable storage identifiers. Build and development tools now use the zwip desktop binary.',
      },
    ],
  },
  {
    id: '2026-10-13-movable-sidebars',
    version: '0.1.0',
    date: '2026-10-13',
    title: 'Your tools, on either side',
    summary: 'Arrange Project, Git, Database and HTTP around your editor.',
    changes: [
      {
        type: 'added',
        title: 'Move tools between sidebars',
        description:
          'Drag a tool tab to the opposite sidebar, or use its Move menu. Put Git beside Project and switch between them. Each workspace remembers tool positions and which panel is open on each side.',
      },
      {
        type: 'improved',
        title: 'Keep your place when moving',
        description:
          'Moving tools preserves Project tree state, Git drafts, database edits and HTTP requests. Switching away from pending database row edits still asks before discarding them.',
      },
      {
        type: 'improved',
        title: 'The website follows the IDE’s blue theme',
        description:
          'Explore the product through a redesigned navy-and-blue landing page with a larger wordmark, illustrated navigation relationships, real workspace screenshots and layouts for desktop and mobile.',
      },
    ],
  },
  {
    id: '2026-10-13-intellij-import',
    version: '0.1.0',
    date: '2026-10-13',
    title: 'Bring your IntelliJ settings',
    summary:
      'Review familiar keybindings, database connections and run configurations before bringing them into Zwip.',
    changes: [
      {
        type: 'added',
        title: 'IntelliJ keymap import',
        description:
          'Open Import from IntelliJ in Settings to read an exported ZIP, configuration folder or XML file. Review inherited keybindings, unsupported actions and conflicts, then save the supported bindings in Settings.',
      },
      {
        type: 'added',
        title: 'Database connection import',
        description:
          'Select supported MySQL, PostgreSQL, SQLite and Redis connection details to import. Existing connections stay intact. Passwords must be entered again, and unsupported tunnel, authentication or TLS settings require manual setup.',
      },
      {
        type: 'added',
        title: 'Reviewed run and debug configuration import',
        description:
          'Import supported npm scripts and local Go run/test configurations into the open workspace. Review commands before saving; nothing launches during import. Supported Go debug targets preserve their working directory. Environment values, remote targets and unsupported launch settings require manual setup.',
      },
      {
        type: 'added',
        title: 'Compatible appearance settings',
        description:
          'Map recognized IntelliJ appearance settings to Zwip’s light or dark theme. Custom fonts and color schemes are reported as outside this import.',
      },
    ],
  },
  {
    id: '2026-10-13-product-page',
    version: '0.1.0',
    date: '2026-10-13',
    title: 'Meet Zwip',
    summary: 'Explore the workspace and find everything you need to try the personal preview.',
    changes: [
      {
        type: 'added',
        title: 'A product landing page',
        description:
          'See real editor and Git screenshots, explore the optional tool packages, and follow the guide to build the preview. The page works on desktop and mobile.',
      },
      {
        type: 'improved',
        title: 'A clearer introduction on GitHub',
        description:
          'The README introduces the main workflows, package setup and current preview limits. A separate development guide keeps build and verification details easy to find.',
      },
      {
        type: 'maintenance',
        title: 'An independent website build',
        description:
          'The product page has its own local preview and static build commands, with self-hosted fonts and no analytics or external runtime services.',
      },
    ],
  },
  {
    id: '2026-10-13-update-history',
    version: '0.1.0',
    date: '2026-10-13',
    title: 'What’s new, all in one place',
    summary: 'Browse new features, improvements and fixes without leaving your workspace.',
    changes: [
      {
        type: 'added',
        title: 'Update history',
        description:
          'Open What’s new from the status bar or action search. Select an update to read its changes, grouped by category.',
      },
      {
        type: 'added',
        title: 'A quick look after an update',
        description:
          'New notes open once at startup. Dismiss them to keep them from reopening for the same update, across all your workspaces.',
      },
      {
        type: 'maintenance',
        title: 'Consistent release notes',
        description:
          'Every future change must include a dated entry in this history, with a clear description of what changed.',
      },
    ],
  },
  {
    id: '2026-10-13-git-right-sidebar',
    version: '0.1.0',
    date: '2026-10-13',
    title: 'Git on the right',
    summary: 'Review your changes alongside the editor in a dedicated right-hand dock.',
    changes: [
      {
        type: 'improved',
        title: 'A resizable Git sidebar',
        description:
          'Open Git from the right edge, the branch button or action search. Its width and visibility are remembered for each workspace.',
      },
      {
        type: 'improved',
        title: 'Changes above the diff',
        description:
          'The file list and diff are stacked to fit the sidebar. Partial commits, merge resolution and push review remain available.',
      },
    ],
  },
  {
    id: '2026-10-13-initial-preview',
    version: '0.1.0',
    date: '2026-10-13',
    title: 'The first personal preview',
    summary:
      'A general-purpose workspace with downloadable development tools. Release qualification is still in progress.',
    changes: [
      {
        type: 'added',
        title: 'Editing and navigation',
        description:
          'Work with tabs, split editors, search, declaration and usage navigation, unsaved-buffer recovery and Local History.',
      },
      {
        type: 'added',
        title: 'Install the tools you need',
        description:
          'Go, Web, React/Next.js, SQL, Redis and HTTP tools are available as separate packages. Language support reports incomplete analysis when needed.',
      },
      {
        type: 'added',
        title: 'Review Git operations before applying them',
        description:
          'Organize changelists, commit selected changes, resolve three-pane merges and inspect outgoing commits before pushing.',
      },
    ],
  },
];
