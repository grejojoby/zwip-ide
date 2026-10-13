# Import settings from IntelliJ IDEA Ultimate

Open **Settings → Import from IntelliJ…** in Zwip. Import reads your chosen source and shows a preview; it does not change IntelliJ's files or connect to a database.

## Choose a source

- **Settings ZIP:** In IntelliJ, use **File → Manage IDE Settings → Export Settings**. Include your keymaps and global data sources when available, then choose the ZIP in Zwip.
- **Configuration folder:** On macOS, choose the appropriate version under `~/Library/Application Support/JetBrains/`, for example `IntelliJIdea2022.3`. Custom keymaps live in `keymaps/`; selected keymap and appearance metadata live in `options/`.
- **Project connections:** Choose the original project's `.idea` folder or `dataSources.xml`. Keep `dataSources.local.xml` alongside it so supported local connection metadata can be read. Settings exports do not necessarily contain project-level data sources.
- **Individual keymap:** Select its XML file. Include parent custom keymaps by selecting their containing folder when inheritance needs to be resolved.
- **Run/debug configurations:** Select the original project folder, `.idea`, `.idea/runConfigurations`, `.run`, an individual `*.run.xml`, or `.idea/workspace.xml`. Only run configuration components are considered in `workspace.xml`; unrelated application state is ignored.

The optional **Original project directory** resolves `$PROJECT_DIR$` database and run configuration paths. It initially uses the open Zwip workspace, if any. Check it when importing another project's settings, and review the resolved paths before importing.

## Keybindings

Select the keymap and review the current and proposed bindings. **Use reviewed keybindings** adds them to the Settings draft; it does not save them yet. Resolve any conflicts, then choose **Save settings**. Canceling Settings discards that draft.

The importer maps commands currently configurable in Zwip: save file, file/symbol/action search, workspace text search, navigation back/forward, declaration/usages, implementations, find usages, format, rename, quick fixes and breakpoint toggle. IntelliJ **Save All** maps to Zwip **Save file**, with that difference called out in the preview.

Custom inheritance is resolved within the chosen source. The supported built-in macOS parent uses defaults verified against the installed IntelliJ IDEA 2022.3 keymap. Original Control bindings remain Control on macOS; Command is represented by Zwip's `Mod` modifier. Explicitly cleared bindings remain unassigned.

Zwip currently stores one keyboard shortcut per supported action. Chords, extra alternate bindings, mouse gestures, unavailable actions and unresolved parents appear in the notes. A partial mapping is labeled as such. It is not a claim that the full IntelliJ keymap or all its actions were imported.

## Database connections

Review each connection's target, user and TLS setting. Select supported entries, then choose **Import selected connections**. This saves metadata immediately and separately from the keyboard-settings draft. Existing connections are preserved; already imported or equivalent entries are identified during review and rechecked when applying.

The supported targets are MySQL, PostgreSQL, SQLite and Redis with representable connection settings. Unsupported drivers, tunnel/authentication requirements, custom certificates or JDBC options are flagged for manual setup instead of silently dropping them. The source is checked again before importing; if it changed, preview it again. A selected connection batch is saved in one SQLite transaction.

MySQL/PostgreSQL URLs without an explicit TLS mode import with **verified TLS required**, with a visible warning. IntelliJ's default can fall back to an unencrypted connection; Zwip's simple TLS switch cannot preserve that behavior. Servers without trusted TLS need manual connection setup. Explicitly disabled TLS remains disabled, and settings that require custom trust behavior need manual setup.

Passwords, SSH keys, IntelliJ's Keychain/KeePass credentials and secrets embedded in JDBC URLs are not transferred. After importing, open **Database tools**, select **Edit…** for a saved connection, and enter its password. Zwip stores entered credentials in macOS Keychain. Install and enable the SQL or Redis package before connecting. Import itself needs neither package and makes no network connection.

## Run/debug configurations

You can also choose **Import from IntelliJ…** at the bottom of the Run panel's configuration list, which opens the same review for run configurations only. Open the destination workspace first. Supported configurations are initially **unselected**. Review each command, working directory and debugger target, select the entries you want, then choose **Import selected run configurations**. They are saved immediately, separately from the keybinding draft. The source fingerprint is rechecked and the batch is saved once, preserving existing configurations and the toolbar's current selection. Importing never starts a task or debugger.

- **npm:** One `run`/`run-script` script, using its workspace-local `package.json` directory. Program arguments are preserved as literal arguments. Execution uses npm and Node available to the application shell; custom IntelliJ runtimes and package managers need manual setup. Use external browser DevTools for web debugging.
- **Go application:** Directory or local package (`.`) scope with an explicit working directory matching its target. Run uses the approved `/Users/grejo.j/.gvm/gos/go1.25.5/bin/go` SDK. A supported debugger target is saved with its arguments and working directory.
- **Go tests:** Local package (`.`) tests support Run and Debug. Directory tests retain recursive `./...` execution and import **Run only** because one Delve session cannot debug multiple test packages.

Choose a saved configuration in the toolbar and click **Run**. For configurations with a Go debug target, **Debug…** opens a prepared target in Go tools; choose **Debug prepared configuration** to start it. The Go package must be installed and enabled. The debugger validates its working directory inside the selected module and uses the Go package's configured SDK; changing `ZWIP_GO` does not rewrite the saved Run command's explicit SDK path.

Unknown types, Java/JVM configurations, file-only Go builds, nonlocal Go import paths, custom Go flags, environment values/files, nontrivial before-launch tasks, remote/container targets, and unrepresentable options are shown as needing manual setup. Potential credentials and URLs in run fields are withheld. Custom macros are not executed. This is a compatibility importer for the supported subset, not an importer for every IntelliJ runner.

## Appearance and other configuration

Recognized light/dark appearance settings can be applied with the separate **Apply appearance** button. This changes the theme immediately. It does not import custom fonts or color palettes.

Code style, live templates, inspection profiles, installed plugins and other IntelliJ settings are outside this importer. They are not executed or installed from the archive. Support for importing a setting does not imply that the corresponding IntelliJ feature exists in Zwip.

## Source handling

Only recognized settings files are read. ZIP entries are read without extracting them into the workspace, with bounded entry counts and sizes. Unsafe archive paths, symbolic links, malformed XML and DTD/entity declarations are rejected. Raw XML and JDBC secrets are not included in preview or error messages. Previewed connection metadata is used only after explicit selection and apply.

Implementation contracts are in `src/model/intellij-import-contracts.ts`; the core methods are `intellij.preview` and `intellij.importConnections`. Keybindings use existing settings persistence after review. Run configurations use the workspace's existing run session, with duplicate identity/name checks and one batch write. Connection import records live alongside connection metadata and never replace existing saved connections.

## Format references

JetBrains documents [custom keymap inheritance and locations](https://www.jetbrains.com/help/idea/configuring-keyboard-and-mouse-shortcuts.html), [manual settings export](https://www.jetbrains.com/help/idea/sharing-your-ide-settings.html#export-your-settings-manually), and [project/global data-source sharing and credential exclusions](https://www.jetbrains.com/help/idea/managing-data-sources.html#share-data-sources).

Run mappings follow JetBrains' [npm configuration](https://www.jetbrains.com/help/idea/run-debug-configuration-npm.html) and [Go configuration](https://www.jetbrains.com/help/idea/go-plugin-run-debug-configurations.html) descriptions. XML formats are not a stable public interchange contract; unknown options stay unsupported.
