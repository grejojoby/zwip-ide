# Go language package

This package is a small, additive bridge inside **gopls v0.21.1**, pinned by module and go.mod checksums in `upstream.lock.json`. That release supports the required Go 1.25.5 toolchain. It runs one process and one gopls cache/session, with an explicit view for each independent `go.mod` context. It does not generate a `go.work` file or keep one server process per module.

## Build and verify

```sh
node packages/go/build.mjs deps
node packages/go/build.mjs test
node packages/go/build.mjs build
node packages/go/build.mjs debug-test -run TestDelve
```

The bootstrap always invokes `/Users/grejo.j/.gvm/gos/go1.25.5/bin/go`, unless an explicit absolute `ZWIP_GO` overrides it. It pins `GOTOOLCHAIN=local`; it never substitutes an automatically downloaded toolchain. Bootstrap dependencies, Go build caches and gopls analysis caches live under ignored `packages/go/upstream`. The build emits `dist/packages/go`, including both executables, checksummed manifest, upstream lock, licenses, and notices generated from the modules actually linked into both binaries. `buildGoPackage({outDir})` is also exported for the root build script. A changed upstream lock rebuilds the generated checkout rather than reusing old source.

The runtime host supplies a generic writable `ZWIP_PACKAGE_CACHE` directory. Before initializing gopls, this package sets its own `GOPLSCACHE=<cache>/gopls` and `GOCACHE=<cache>/go-build`; language-specific environment does not belong in Core. Direct adapter invocations without the generic directory retain explicit `GOPLSCACHE`/`GOCACHE` settings. Initialization probes gopls's cache before starting analysis and reports an error if unavailable: an inaccessible upstream cache can otherwise silently degrade imported type analysis.

The executable is `bin/zwip-go`. Runtime overrides use `ZWIP_GO`, `ZWIP_DLV`, `ZWIP_DAP_LOG`, and `ZWIP_PACKAGE_CACHE`.

The complete suite includes a 33-context fixture, with 32 independent unopened consumers of one source module. `node packages/go/build.mjs test -short` skips that larger fixture. These are synthetic correctness fixtures; real-workspace measurements are recorded separately.

## Protocol and context semantics

The worker implements the root [provider protocol](../../docs/protocol.md): JSON-RPC 2.0 over JSON Lines; `initialize`, `document.update`, `document.close`, `workspace.changed`, `workspace.status`, `workspace.symbols`, `navigation.query`, `editor.request`, `tool.request`, `$/cancelRequest`, and `shutdown`. Protocol output is restricted to stdout and diagnostics to stderr. Source positions use UTF-16. Navigation/editor requests accept optional `sourceContextId` provenance. Read-only dependency Go files at revision zero are resolved only through an exact physical file in that context’s loaded metadata; absent provenance uses a loaded graph owning that exact file. Dependency files cannot receive overlays or editor edits. References and relationship searches remain scoped to the included project roots. Paths are canonical absolute filesystem paths, including unsaved new files. Document revisions must increase, and workspace generation must match. `workspace.changed` takes `{paths: string[]}` and invalidates disk snapshots while preserving unsaved overlays. `document.close {path}` follows didClose semantics and drops the overlay even after external disk changes. The host sends it only for clean buffers and retains dirty recovery buffers without closing their overlays. Reinitialization replaces the session and all its overlays; the host must resend unsaved documents after a branch/context switch.

Initialization acknowledges the configured contexts in `loading` state, then creates their views in the background with at most two context loads active. `workspace.status` returns `{generation, contexts}` with live ready/loading/failed states and reasons. Document and navigation requests promote their module ahead of queued background modules; an unavailable loading context returns explicit partial coverage and a retry reason. The host polls readiness and may retry the original request once its source context is ready. Shutdown and reinitialization cancel all context loaders. Each supplied Go context receives one explicit view. The nearest `go.work` within the opened workspace applies only if it lists that module; otherwise `GOWORK=off` preserves its independent module/replace graph. Ambient workspaces outside the project are ignored. Metadata and tool commands preserve readonly or automatic vendor mode (including workspace vendor directories). Go 1.25 may write `go.work.sum` even with `-mod=readonly`, so a private checksum overlay protects that file without changing the module graph. Missing checksums produce explicit load/build failures instead of project writes.

The workspace-owned `.zwip.json` can add simultaneous named profiles without changing Go module files:

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

Core preserves default contexts and expands each selected module into a context with ID `<baseId>#<profileId>`, `profileId` and `settings`. All four Go settings are optional; unspecified values retain the SDK/environment defaults. An explicit empty tag array clears inherited build tags. Unknown settings, malformed tags and target pairs unsupported by the configured SDK are rejected. Each profile has a separate upstream view in the same session, including through unsaved document open/change/close. Upstream automatic target guessing is disabled: an excluded file requires selecting an explicit configured profile. Requests without `sourceContextId` keep using the default profile; explicit provenance selects a named profile. Global queries include all selected module/profile contexts and report contributing context IDs. Native run/test/debug preserve tags and explicit workspaces; cross-target execution is rejected before launching a child. Compile-only cross-target tools are not implemented.

For references and incoming calls, the worker resolves the symbol's physical declaration in the source context, then queries every selected context whose metadata graph contains that declaration. Identical import paths resolving to different local replacement trees stay distinct. Results deduplicate by source range and relationship while retaining contributing context IDs. Queries can explicitly scope their context IDs. Definitions, type definitions and outgoing calls use the source context. Alias type definitions retain the declared alias spelling, matching the pinned upstream implementation. `workspace.symbols` searches all included contexts without an active document; its upstream 100-symbol-per-context limit is reported as partial when reached.

For interface/type relationships in unrelated modules, an additive helper passes gopls's existing method-set key between snapshots and searches the existing method-set indexes. It checks physical source identity for named signature types and private members before comparing fingerprints. It builds no second index. Existing upstream implementation and hierarchy queries continue to handle source-local cases.

Every navigation result includes searched/total context counts and complete, partial, canceled, failed or unsupported state. Global searches keep verified locations from healthy packages and mark incomplete context coverage partial. An unrelated broken package cannot hide a valid direct definition; source-package errors still make the direct result partial. Edits invalidate concurrent queries through a snapshot epoch. Cancellation is cooperative and propagates through gopls calls; the host must still discard obsolete generations and revisions.

`navigation.query` also emits JSON-RPC `navigation.progress` notifications after each context finishes. Notification `params` is a cumulative navigation batch with the same query ID, document revision and workspace generation, `state: "loading"`, verified locations and explicit searched/total counts and reasons. The source context is searched first. Published batches are immutable; canceled or changed snapshots stop further publication. The ordinary final response remains authoritative. Progress does not apply to editor or rename operations.

## Editor operations and edit previews

`editor.request` supports `completion`, `hover`, `diagnostics`, `format`, `rename`, `symbols` and `codeActions`, with the shared document revision and workspace generation fields. Completion returns plain insertion text, replacement ranges and any required additional import edits. Hover contains upstream Markdown. Diagnostics include upstream parse, type and analyzer results for the current file. Formatting returns gofmt edits. Symbols return the current document outline, optionally filtered by `query`.

Code actions currently support `source.organizeImports` (the default when no query is supplied). Each action contains its own title, kind and edits; unrelated action alternatives are never combined. Command-only actions and arbitrary refactors are not advertised as executable operations.

All edit operations return previews and **never write source files**. Each edit includes its canonical path, document revision, range, replacement text and the SHA-256 `fileHash` of the full analyzed document bytes. The host must check both revision and hash against current buffers/disk before applying the complete preview. Hashes protect unopened files whose document revision is zero. Canceled or obsolete requests expose no edit list.

Rename resolves one physical declaration, checks every module graph, gathers upstream rename edits from every applicable context, and deduplicates consistent edits. Package-load errors, compiler errors in applicable contexts, overlapping/conflicting edits, excluded/external source and resource moves block the entire preview. A shared file binding a name to different conditional declarations across profiles also blocks rename: changing only one declaration would break the other profile. Method renames are also blocked when another independent context lacks the declaration: complete coverage of implicit implementations cannot yet be proven. This conservative restriction is deliberate; successful ordinary-symbol previews are complete for the included, configured workspace. Rename does not change reflective string references or external consumers outside that workspace. Renaming a package clause renames the package in place, as GoLand does: its package clauses, the external `_test` package and importers' qualified references change, while its directory and import path stay. `main` and a module's root package cannot be renamed this way.

## Current scope and limitations

- Implemented: definitions, type definitions, references, method-set implementation candidates, type relations, static incoming/outgoing calls; unsaved overlays; multiple independent modules; replace identity and provenance; explicit query scopes and cancellation.
- Cross-context method-set searches return **partial** with a reason: upstream indexes package-level types, so function-local types in unrelated packages are not covered; generic fingerprint matches remain candidates. The result relationship says `method-set candidate`; within-context type hierarchy uses `method-set supertype` and `method-set subtype`, which are assignability relations rather than direct class-inheritance edges. These are static relationships, not runtime dispatch guarantees.
- Calls follow gopls's static call hierarchy; reflective calls, runtime function values and exhaustive interface dispatch are outside its contract. An empty result does not prove no runtime caller exists.
- Loading, build constraints and missing dependencies follow the selected module/profile configuration. Only explicitly configured targets/tags are covered. The host must reinitialize after externally changed module, profile configuration or branch state.
- Run, test and coverage use real Go commands; the [tool protocol](TOOLS.md) describes lifecycle and results. The real Delve backend passed native breakpoint, stack, locals, watch, stepping, pause/resume and cleanup fixtures under the race detector on macOS arm64; IDE UI qualification is separate.

## Fork maintenance

The maintained gopls fork consists of `overlay/cmd/zwip-go/*.go` and additive `overlay/internal/{golang,cache}/zwip_*.go` helpers. The cache bridge creates explicit views with distinct folder options at the same physical module root, which public `Session.NewView` rejects; upstream snapshot, invalidation and lifetime logic remain in use. Its pinned x/tools dependency also carries one explicit source-line patch in `patches/tools-imports-gowork-off.json`: the import resolver must treat `GOWORK=off` as independent-module mode to find vendored imports. Vendor-mode modules select upstream's goimports source, which can discover unused packages present only in vendor; the default gopls source searches loaded metadata and module caches. Bootstrap verifies both module checksums, verifies the patch anchor, and applies a local dependency replacement only inside generated upstream source. An upstream bump requires changing the lock, rebuilding the copied source, and rerunning the integration fixtures; internal APIs are not stable.

Primary upstream references: [navigation behavior](https://go.dev/gopls/features/navigation), [workspace configuration](https://go.dev/gopls/workspace), [gopls source](https://cs.opensource.google/go/x/tools/+/gopls/v0.21.1:gopls/), [Go module workspaces](https://go.dev/ref/mod#workspaces).

## Workspace checkpoints

Initialization accepts the host's optional `workspaceIndex` identity (`epoch`, `rebuild`).
The owned `gopls-workspace-index.json` patch restores a serialized package/import graph
only after hashing its source, dependency, module, SDK and directory inputs. Custom package
drivers and gccgo conservatively use live loading. Configured environments, profiles and
normalized checksum overlays isolate cache keys; raw environment values are not persisted.

`workspace.index` validates upstream export data, cross-references, method sets, tests and
diagnostics, then builds missing artifacts and waits for their writes before reporting
`indexState: built`. An unchanged new process reports `restored`; `metadataRestored` reports
actual package-graph reuse separately. `workspace.restore` verifies existing artifacts without
starting missing full type-check batches. Missing/corrupt data falls back to normal live
queries, with explicit index status. Go environment discovery and live compiler hydration
still occur; a restored index does not mean the provider process itself is serialized.

The file cache publishes checksummed immutable artifacts atomically. Its upstream eviction
policy can discard old artifacts; verification catches that and rebuilds rather than trusting
saved counters. Workspace content changes invalidate affected package handles. The host's
workspace rebuild epoch isolates a deliberate rebuild from other workspace checkpoints.
