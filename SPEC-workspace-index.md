# Persistent workspace index

Status: implemented and verified across independent Go/web worker processes and two native application launches.

## Objective

Save a complete workspace index during indexing and restore it when the same workspace
opens again. An unchanged workspace must reuse its saved semantic data without running
another full indexing pass. Changed inputs must invalidate affected data before it can
produce complete navigation results.

Assumptions: this covers the workspace file/context inventory and both existing semantic
providers, Go and web. A workspace includes all discovered modules and explicit build
profiles. SQL connections and console history are separate features. Language-server
processes and live compiler objects still need to start; they are not themselves serialized.
Restoring saved data must not be described as zero-cost startup or guaranteed instantaneous
navigation.

## Existing behavior and constraints

- `workspace.open` scans files and discovers contexts again.
- The UI unconditionally requests `workspace.index` when index-on-open is enabled.
- Go stores export data, cross-references and other analysis artifacts in its gopls file
  cache, but rebuilds package metadata and resets warm-up progress in each worker process.
- The web provider creates language services in memory. It has no persisted workspace
  semantic index or restore protocol.
- A completion marker, saved progress counters, cached previous query answers, or the
  workspace file list alone does not satisfy this feature.
- Rust remains language-neutral. Go/gopls and TypeScript implementation belongs in the
  corresponding installable packages. Existing document-revision, workspace-generation,
  provider failure and context-coverage contracts remain mandatory.

## Persisted data

Use an application-data directory keyed by canonical workspace root, outside source trees.
Store a versioned workspace manifest with the inventory, context/build-profile identities,
exclusions, discovery-rule identity, source/configuration fingerprints, and provider-owned
checkpoint descriptors. Each provider descriptor identifies its executable/package version,
SDK/toolchain, settings, covered contexts, artifact format and artifact checksums.

A provider checkpoint must contain sufficient semantic data to restore the completed
index. For Go, investigate restoring the package/dependency graph together with the
existing export/cross-reference/method-set artifacts through the owned gopls overlay.
For web, implement provider-owned persisted semantic data; do not assume the TypeScript
language-service heap or a compiler build-info file is a complete navigation index.
Operations that still need live compiler objects may hydrate them on demand, but cannot
claim cached completeness without the required validated semantic data.

Persist actual artifacts before publishing a checkpoint that refers to them. Write a new
generation atomically, retain the last valid generation until publication succeeds, and
handle concurrent windows without mixing their snapshots. Checkpoint completed work during
indexing so persistence does not depend on the application exiting cleanly. An interrupted
or failed indexing pass must remain explicitly incomplete and must not overwrite the last
usable complete snapshot.

Indexes may contain private source metadata. Keep them local with restrictive permissions;
do not record passwords or raw credential-bearing environment values in manifests. Hash
relevant environment identities instead.

## Restore and invalidation

On open, find the workspace manifest and validate its schema, root, settings, provider
versions and artifact integrity. Validate changes made while the IDE was closed, including
added/deleted/renamed files, source changes, dependency changes and build-configuration
changes. File size or mtime alone is insufficient evidence of unchanged semantic inputs.
Include relevant external dependencies, SDK identity, symlink resolution and ignore rules.

Load validated inventory and semantic artifacts. Rehydrate provider state from the saved
index rather than scheduling another full warm-up. Preserve explicit per-context coverage;
never turn a failed provider or a missing artifact into a complete empty result.

Use the dependency graph to invalidate affected contexts/packages and reverse dependencies
when correctness can be established. If a provider cannot prove that a smaller refresh is
safe, fall back to rebuilding that provider's affected workspace data. Unsaved overlays
must retain document-version preconditions and must not become the authoritative saved-file
index. Workspace changes received during validation must be reconciled before restored data
is published as current.

Corruption, missing artifacts, incompatible versions or unwritable storage must produce an
honest restore/index status and a safe live-indexing fallback. Do not report "loaded" merely
because a manifest exists. Cache cleanup may remove old generations, but must not delete SQL
history, document recovery data, or the currently published generation in use by a window.

## Provider boundary and UI

Add explicit, versioned provider checkpoint/restore capabilities. The foundation handles
workspace lifecycle, manifest publication and freshness orchestration; providers own their
serialized semantic formats and dependency validation. Old or unsupported providers fall
back to live indexing and are identified as not restored.

Keep distinct UI states for validating a saved index, loading it, indexing changed work,
and indexing from scratch. Loaded counts describe validated index coverage, not copied old
progress counters. The existing index-on-open setting controls eager construction/warming;
loading an existing valid index must not require enabling a new full warm-up. Provide a
workspace-scoped rebuild action that deliberately discards that workspace's checkpoint and
rebuilds it without deleting unrelated application data.

## Implementation locations and style

- `crates/ide-core/src`: manifest storage, lifecycle and language-neutral provider contract.
- `packages/go/overlay`: Go restore/checkpoint implementation and provider tests. Any
  required pinned-upstream changes are reproducible owned patches, not manual edits to
  downloaded source.
- `packages/web/src`: web semantic checkpoint implementation and tests.
- `src/components/IndexingStatus.tsx`, settings and contracts: truthful restore/index status.
- `crates/ide-core/tests`, `tests/packages`, `tests/e2e`: cross-process and desktop verification.
- `src/content/updates.ts`: implementation delivery notes when behavior actually ships.

Use existing Rust/Go/TypeScript style and small modules. Keep contracts explicit, for example
`restoredContexts` and `invalidatedContexts` as distinct collections; do not use a single
boolean that conflates a partial restore with a complete index. Reuse existing hashing,
serialization and atomic-file facilities before adding dependencies.

## Acceptance checks

1. Index a disposable multi-module workspace, terminate the process, and open it in a new
   process using the same data directory. Verify actual semantic artifact reuse and matching
   definitions, usages and workspace symbols; timing or a saved marker alone is insufficient.
2. Verify Go and web independently, then a mixed workspace. Exercise explicit profiles,
   context coverage and document/workspace version preconditions.
3. Verify offline edits, same-size/mtime-preserving edits, additions, removals and renames.
   Results must reflect current content, and invalidated scopes must not claim completeness.
4. Change build tags, target, module/workspace manifests, exclusions, dependency inputs,
   SDK/toolchain and provider versions. Verify correct invalidation and isolation.
5. Delete/corrupt an artifact, interrupt a checkpoint, exhaust/write-protect its directory,
   and race two windows. Verify safe fallback and preservation of the last valid snapshot.
6. Verify unsaved/recovered buffers do not poison the saved workspace checkpoint.
7. In the native app, verify cold indexing, full quit/reopen, restored coverage, fresh
   navigation, changed-file refresh and explicit rebuild.
8. Measure first-index and reopen behavior on fixtures and, where appropriate, the read-only
   representative Go workspace. Record measured results and remaining initialization work.
   Never modify that representative workspace for implementation or benchmarking.

## Validation commands

- `cargo test --workspace`
- `npm test`
- `npm run test:go` (the build script uses the configured Go executable)
- `npm run check`
- `npm run build:e2e` followed by targeted `npm run test:e2e -- --mochaOpts.grep ...`
- `npm run build` for the production app and package artifacts

Go must use `/Users/grejo.j/.gvm/gos/go1.25.5/bin/go` and its matching GOROOT. Do not search for
another toolchain. Stage new project source files, preserve all published update-history
entries, and do not stage caches, build output, private index data or downloaded upstream
sources. Any dependency, provider-protocol or storage-format change must be reviewed against
this specification and the existing v1 contracts before delivery.

## Delivery verification

The implementation restores the inventory plus provider-owned semantic data. Go graphs
and export/cross-reference artifacts reuse the executable-versioned upstream cache. Web
materializes source token/declaration data; live-only operations hydrate compiler state on
demand. Generated Go test-main files are validated by content without treating their cold
creation timestamps or unrelated cache-bucket entries as source edits. Custom Go drivers,
gccgo and cgo-generated metadata conservatively reload through the live driver.

Verified the full JavaScript suite (416 passing, 5 existing skips), Go suite, sequential Rust
workspace suite, formatting/type/lint/clippy checks, and production build. The native harness
ran independent cold and warm application processes with the same disposable data directory:
all three configured contexts restored, including the Go profile and actual Go metadata.
It also verified web definitions, a timestamp-preserving offline edit and forced rebuild.
The source-change validation mutation failed regression tests as expected and was restored.

The exhaustive failure matrix above remains the design's validation reference. Synthetic
fixtures exercise corruption, missing artifacts, partial writes, storage failures, changes,
versions and process restart; no disk-exhaustion experiment or representative-workspace
performance claim is made. The read-only representative workspace was not modified.
