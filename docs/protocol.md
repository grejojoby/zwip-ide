# Provider protocol v1

Core IPC is `ide_request(method, params)`. Renderer wrappers and authoritative DTOs are in `src/api.ts` and `src/contracts.ts`; Rust validates request state before accepting results or mutations. The native bridge must release application-wide locks before blocking provider work.

Workspace replacement rejects unsaved open mirrors after discovering the new root and before changing the active watcher, workers, tasks, or generation. The dirty check and replacement share the document lock so edits accepted during discovery cannot be cleared. Clients must stop accepting editor mutations and flush queued deltas before requesting a switch. A rejected switch preserves the current workspace and recovery records. `document.close` returns `{released: false}` for a dirty buffer; clients must retain that buffer instead of treating the response as successful release.

## Worker transport and lifecycle

Each worker uses JSON-RPC 2.0, one UTF-8 JSON object per line on stdin/stdout. Diagnostics belong on stderr. The RPC request ID is independent of the semantic DTO's string `id`; preserve both identities. Cancellation is `$/cancelRequest {id}` using the RPC ID. `shutdown` releases provider sessions, overlays and owned task processes. Providers must not use stdout for logs.

| Method              | Parameters                                                        | Result / effect                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `initialize`        | `{root, contexts, generation, enabledPackages?, workspaceIndex?}` | Provider capabilities/metadata and `{generation, contexts}` readiness. Each configured context stays individually visible; failed contexts have reasons. Go acknowledges loading and prepares views asynchronously. Web restores validated checkpoints or initializes live programs. Optional versioned checkpoint capabilities and identity are described in [workspace indexes](workspace-index.md).                        |
| `workspace.status`  | `{}` or omitted                                                   | `{generation, contexts}` from current provider state, without restarting or reinitializing. Contexts use `loading`, `ready` or `failed`, with a reason where applicable. Web also exposes SDK/plugin metadata.                                                                                                                                                                                                                |
| `workspace.index`   | `{}` or omitted                                                   | Starts every language provider the workspace needs so all contexts load now, and sends providers `workspace.index` to pre-build caches. Returns `{started: [{language, warming}], unavailable: [{language, reason}]}`. Go and web validate existing semantic checkpoints and build missing data in the background. Contexts report `indexState`, `indexReason`, `indexed`/`packages`, and `indexUnits` in `workspace.status`. |
| `document.update`   | `{path, content, revision}`                                       | Replaces the provider's in-memory overlay and acknowledges its revision. Never writes source. Only provider-supported document extensions owned by the opened workspace are sent.                                                                                                                                                                                                                                             |
| `document.close`    | `{path}`                                                          | Drops the overlay, so later reads use disk and unopened revision zero. Core sends this only when releasing a clean buffer; dirty recovery buffers retain overlays.                                                                                                                                                                                                                                                            |
| `workspace.changed` | `{paths: string[]}`                                               | Invalidates changed disk snapshots/file lists while retaining unsaved overlays. Configuration or branch/context changes can require host reinitialization.                                                                                                                                                                                                                                                                    |
| `navigation.query`  | `NavigationQuery`                                                 | `NavigationBatch`, with query identity, revision/generation, locations, context coverage and explicit state/reasons.                                                                                                                                                                                                                                                                                                          |
| `workspace.symbols` | `{id, query, workspaceGeneration}`                                | `NavigationBatch` with `documentRevision: 0`; searches configured contexts without requiring a selected editor tab. Provider limits produce partial coverage.                                                                                                                                                                                                                                                                 |
| `editor.request`    | `EditorRequest`                                                   | `EditorResult`, containing only the data supported by that operation.                                                                                                                                                                                                                                                                                                                                                         |
| `tool.request`      | `{method, params}`                                                | Package-specific tool result; see Go `TOOLS.md` and SQL/Redis/HTTP services.                                                                                                                                                                                                                                                                                                                                                  |

`workspace.restore` starts providers and asks them to validate/restore saved indexes without full eager construction. Core `workspace.refresh {rebuildIndex: true}` changes this workspace's checkpoint epoch; follow with `workspace.index` to rebuild. Cache failure does not change semantic coverage into a complete empty result. See [saved workspace indexes](workspace-index.md) for formats, invalidation and limitations.

Positions and ranges use zero-based UTF-16 line/character coordinates. Core document deltas use UTF-16 offsets. Paths at this boundary are canonical absolute filesystem paths, not encoded URIs; adapters translate to upstream URI formats. Versioned open documents use their current overlay revision. Unopened and read-only dependency-source queries use provider revision zero. Dependency paths must belong to an actually loaded source graph, with optional `sourceContextId` provenance; arbitrary external files do not become workspace members. Providers reject external overlays and source edits.

`NavigationQuery` includes `id`, `operation`, `path`, `position`, `documentRevision`, `workspaceGeneration`, and optional `contextIds`/`sourceContextId`. Operations are definition, type definition, references, implementations, type hierarchy, incoming calls and outgoing calls. Locations include their contributing `contextIds` and relationship labels. Explicit Web `extends`/`implements` edges are distinct from structural compatibility; Go method-set candidates are not labeled as class inheritance or exhaustive runtime dispatch.

A result is `complete`, `partial`, `canceled`, `failed` or `unsupported` (the UI may also represent `loading`). Unsupported operations, unresolved dependencies, failed context loads, truncation and incomplete relationship coverage never become successful empty answers. The host checks request ID, document revision, workspace generation, analysis epoch and current provider identity as applicable before displaying/applying results. A successful response from an old worker is not authoritative after replacement. Provider cancellation is cooperative; stale-result rejection remains mandatory.

When Core sets `reportProgress: true`, providers emit `navigation.progress` JSON-RPC notifications whose `params` are cumulative, immutable `NavigationBatch` snapshots with state `loading`. Go and Web publish after each searched context. A final response still ends the request. Core retains only the latest snapshot per active query, and `navigation.progress {id}` exposes it after checking revision, generation, analysis epoch, and external-source hashes. The renderer polls only while that query is active. Cancellation, edits, workspace replacement, and completion invalidate the progress lease; late notifications cannot recreate it. The chooser waits for final results while docked usages can display completed contexts early.

Worker stdout accepts JSONL frames up to 64 MiB. Invalid, incomplete, or oversized frames fail the provider explicitly and stop its process; the host never reports a truncated frame as a complete empty result.

## Editor requests and reviewed edits

`EditorRequest` contains `id`, `operation`, `path`, `documentRevision`, `workspaceGeneration`, optional `position`, `range`, `newName`, `query` and `sourceContextId`. Operations are `completion`, `hover`, `diagnostics`, `format`, `rename`, `symbols` and `codeActions`. Responses contain the corresponding optional completions, Markdown/plain hover, diagnostics, source locations, edits or separately titled actions, plus identity/state/reasons.

Edits are `{path, revision, fileHash, range, newText}`. Providers emit the SHA-256 of the full analyzed buffer/file, including revision zero for unopened files. Providers never apply edits to disk. Core `workspace.editPreview` validates the complete edit set against current buffers/disk and returns reviewable before/after content. `workspace.editApply` revalidates the preview and applies all accepted changes to versioned recovery buffers. Explicit save remains a separate operation. A conflict, incomplete rename context, resource move or stale revision/hash rejects the whole preview; command-only actions are not silently executed.

## Package manifests and trust

A worker manifest contains `id`, `name`, `version`, `coreVersion`, `description`, `kind: "worker"`, `capabilities`, `languages`, `documentExtensions`, optional `discovery`, `executable`, `args`, `dependencies`, `platform`, `architecture` and `checksums`. `checksums` maps each relative regular asset path to its lowercase SHA-256. Executable/entry arguments resolve inside the installed directory; the worker's current directory is the opened workspace and its caches use host-controlled locations. Symlinks, traversal, missing/unchecked assets, incompatible architecture/core ranges and invalid metadata are rejected.

A discovery rule is `{language, documentExtensions, configGlobs, configurationGlobs}`. Rules drive generic project discovery, document routing and configuration-change handling; adding a language does not require a Go-versus-Web branch in Core. Installed rule metadata is copied into the trusted registry after validation. Mutable files in an unrelated package cannot rewrite routing or break workspace discovery. Before executing a selected provider, the host still verifies its pinned manifest and package assets; trusted routing metadata is not a checksum bypass.

Optional manifest `syntax: {abi: 1, asset, extensions, fileNames}` selects a checksummed ES-module grammar asset. `fileNames` matches exact extensionless names such as `Makefile`; `package.syntax` accepts `{extension, fileName}`. Core serves assets only from enabled, validated packages, with a 4 MiB limit. The renderer verifies SHA-256 again and supplies a shared CodeMirror/Lezer ABI, so downloaded grammars reuse the editor's primitive instances. Package changes invalidate grammar selection. Go and Web grammars are package assets; JSON remains a core configuration-file convenience. Bundled grammar dependency licenses accompany each package.

A declarative `kind: "feature"` package has no executable or arguments and may use platform/architecture `any`. `react-next` depends on `web` and enables project Next plugin loading through `enabledPackages`; it does not keep a separate process alive.

Installation, enabling and process startup are distinct. The package host validates dependency ranges/cycles and preserves dependency constraints when disabling a damaged package. Only the affected dependency closure is stopped; toggling an unrelated database package must not terminate Go test/debug sessions. Concurrent ordinary cold starts share an immutable launch ticket, initialize outside the host lock and attach only if the package/workspace is still current. Disabled or superseded candidates cannot attach late.

Until one is configured, `package.catalog` uses the built-in catalog at the repository's `packages` GitHub release. `package.catalogConfigure` stores an explicitly supplied HTTPS catalog URL that replaces it. `package.installProgress` reports catalog downloads in flight by package ID (bytes received and expected total, then an installing phase). `workspace.scanProgress` reports files indexed by the running workspace scan. Catalog entries bind ID/version/platform/architecture/dependencies, an HTTPS archive URL and whole-archive SHA-256. Downloads allow HTTPS-only redirects with size/time limits. The selected archive must match the trusted catalog and its own per-asset checksums. This is HTTPS/catalog trust, not a separately signed marketplace. `scripts/package-catalog.mjs` creates ZIPs/catalog JSON for a supplied hosting URL; it does not publish them or invent a hosted service.

Enabled upgrades/restarts validate a candidate before replacing the current worker. Failed candidates leave the previous version/worker in place; a retained verified version supports `package.rollback`. Install/upgrade/restart/rollback use prepare/start/accept phases. Candidate initialization runs outside host and workspace locks. Acceptance rechecks registry mutation epoch, package identity and workspace generation before committing; disable, workspace replacement and shutdown cancel pending candidates. Unaccepted version directories are removed. Local validation/hashing/copying remains in preparation under the host lock.

## Core-owned persistence and tools

Rust owns versioned document mirrors, recovery/history, edit previews, package registry, settings, Git workflows, task processes and terminal lifecycle. Connection profiles use Core credential resolution; tool workers receive only the resolved connection required for a request, rather than credential-store access. SQL/Redis/HTTP workers start only after their packages are installed/enabled. Worker results and diagnostics must not expose stored passwords.

Git mutation requests use reviewed repository fingerprints and operation-specific inputs, never arbitrary renderer-supplied Git argument arrays. Partial commits use separate indexes and reconcile the actual hook-modified commit while preserving unrelated staging. Merge sessions retain base/current/incoming identities and revalidate before applying reviewed results. Push execution rechecks the reviewed destination and commit. Task and terminal processes have explicit IDs, bounded output and stop operations; they are accounted separately from IDE analysis in native benchmarks.

Node-based package builds and bundled runtimes require **Node 24.16.0 exactly**, as enforced by the package build/notice generator. Project TypeScript/Next SDK selection is independent of that worker runtime pin. The Go package pins gopls/Delve and uses its explicitly configured absolute Go toolchain path.

## Explicit build profiles

An optional workspace-root `.zwip.json` adds named contexts while retaining every discovered default context:

```json
{
  "version": 1,
  "buildProfiles": [
    {
      "id": "linux-ci",
      "language": "go",
      "configPaths": ["service/go.mod"],
      "settings": {
        "goos": "linux",
        "goarch": "amd64",
        "tags": ["integration"],
        "cgoEnabled": false
      }
    }
  ]
}
```

Core interprets only profile identity, exact workspace-relative configuration paths, and language routing. Providers validate and interpret the settings object. Derived context IDs are `<default-id>#<profile-id>`, with `profileId`, `settings`, and declarative `documentExtensions` included in `BuildContext`. IDs are unique and limited to 64 characters. Unknown configurations/languages, duplicate contexts, unsupported format versions, more than 64 profiles or 256 additional contexts, and configuration files over 1 MiB are rejected explicitly. No source/module files are rewritten. A failed rescan preserves the previous workspace. Configuration changes invalidate existing analysis.

The editor's build-context selector appears for the nearest applicable project when profiles exist. An unset selection preserves the provider's default context. Explicit selections travel as `sourceContextId`, including through history and subsequent semantic requests. Web projects express variants with separate tsconfig/jsconfig files; custom Web profile settings are reported unsupported rather than silently ignored. Go profile support is verified independently in the package tests.

## Readiness probes and control traffic

`workspace.status` polls workers without killing a healthy but busy provider when its status deadline expires. Every discovered context appears in the response; absent or stopped providers and timed-out readiness probes return `state: "unavailable"` with a reason. Consumers must not retain stale ready state or treat unavailable contexts as settled/complete.

The command-line JSONL host has six ordinary request threads, two reserved control threads, and bounded queues. Progress, cancellation and app information remain available while semantic requests occupy ordinary threads. Replies may arrive out of order and retain request IDs. Clients must await mutations they depend on. CLI input and provider-output frames reject messages over 64 MiB. Closing stdin drains accepted work, cancels semantic activity and shuts down workers while preserving unsaved recovery.

The package host supplies a generic `ZWIP_PACKAGE_CACHE` directory. Each package owns its tool-specific environment and cache layout; Go configures its own Go toolchain, build cache and gopls cache at bootstrap.

## Incoming Git updates

`git.branches` includes `ahead` and `behind` counts for resolvable local upstreams;
unknown or deleted upstreams use `null`. Origin rows summarize their local trackers.
Diverged branches still have incoming commits. An untracked local branch is not silently
assigned an upstream. Single-branch fetch mappings are respected without changing Git
configuration; explicitly fetched origin refs can resolve configured tracking branches.

`git.remoteStatus {}` returns `{root, current, branches, fetch}`. The fetch object has a
`state` (`idle`, `fetching`, `ready`, `failed`, `unavailable`), `lastFetched` Unix seconds,
`error`, and `version`. Initial observation and changes to local refs, checked-out branch,
external `FETCH_HEAD`, or origin configuration schedule a background origin refresh.
Successful checkout, branch creation, checkout/rebase, branch update and pull operations
also schedule it, including no-op pulls. `git.refreshRemote {}` explicitly requests another
refresh. Repeated requests combine into at most one running fetch plus one pending refresh.

The refresh fetches every origin branch into `refs/remotes/origin/*`, prunes stale tracking
refs, skips tags/submodules and leaves local branches/files untouched. It does not rewrite
fetch mappings or `FETCH_HEAD`; its own updates therefore do not trigger a refresh loop.
Fetch runs without interactive prompts, has a 60-second limit and stops at application
shutdown. Failed refreshes retain the last fetched refs and report failure separately from
incoming counts. The workspace UI observes changes every five seconds while visible and
on focus, so branch switches/pulls made in another application are detected when observed.
