# Saved workspace indexes

Zwip stores each workspace's validated inventory under its application-data directory,
keyed by the canonical workspace root. Language packages own their semantic formats in
package cache directories; indexes are local and written with restricted permissions.

With **Index the whole project when it opens** enabled, Go and web providers build missing
semantic data in the background. Reopening reuses valid data instead of repeating a full
warm-up. With the setting disabled, existing checkpoints still load; missing data is
analyzed on demand. Use **Rebuild workspace index** in action search to rebuild the current
workspace. This changes its checkpoint epoch without deleting SQL history or recovery data.

Saved data is validated against file contents, configuration, SDK/dependency inputs and
relevant directory entries. Offline additions, deletions and timestamp-preserving edits
invalidate saved data. Validation still reads files and providers still initialize: restored
does not mean instantaneous startup. Operations needing live compiler objects hydrate them
on demand. Unsaved buffers use live analysis and do not replace the saved-file checkpoint.

Go persists package/import metadata and upstream export data, cross-references, method sets,
test and diagnostic artifacts. Web persists navigation data for every source token plus
relationships for named declarations and file diagnostics/symbols, rather than just answers
to previous user queries. Less common web operations and workspace symbol searches can load
live compiler objects. Web checkpoints are limited to 128 MiB; an oversized or unwritable
checkpoint reports a cache failure while live analysis remains available. Go's upstream cache
may evict artifacts; verification detects missing entries before claiming restored coverage.
Custom Go package drivers, gccgo and cgo-generated inputs conservatively reload package
metadata through the live compiler driver; their existing semantic artifacts remain reusable.

The status bar distinguishes validation, rebuilding, restored context coverage and cache
problems. Open its per-module list for details. A failed provider retains failed/partial
query coverage; cache presence is never evidence of a complete empty result.

Provider extensions are optional: initialization accepts `workspaceIndex` and advertises
`indexCapabilities: ["workspaceCheckpoint", "workspaceRestore"]`. `workspace.index` starts
validation/construction, `workspace.restore` only restores existing data, and
`workspace.status` reports each context's `indexState`, `indexReason` and validated progress.
Web also exposes `workspace.checkpoint` to await a checkpoint for integration verification.
Older packages safely retain their existing live-indexing behavior.

To verify a real application exit and restart with an isolated fixture, build packages and
the e2e app, then run `node scripts/test-workspace-index.mjs`. It launches two independent
native test runs against the same disposable workspace/data directory, checks actual Go
metadata restoration and web definitions, and records cold/reopen timings in ignored
`artifacts/workspace-index-restart.json`. The second run disables eager construction and
also checks a timestamp-preserving edit and an explicit rebuild.

A disposable mixed workspace measurement on 2026-10-16 took 12.05 s
for cold index construction and 9.44 s to reopen and verify restored
coverage across three contexts (Go default, Go profile and web). These fixture measurements
exclude package installation and are not a performance guarantee for larger workspaces.
