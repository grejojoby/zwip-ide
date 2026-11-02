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

## Git activity and source invalidation

Git metadata (`.git` reference, HEAD and index events) is not a source change. The workspace watcher leaves those events to the Git remote monitor, so a fetch or a ref-only branch switch does not request source discovery, invalidate semantic queries or restart providers. Actual source/configuration events still reach document synchronization and language workers; configuration changes and additions still trigger workspace discovery. Checkout/update remain subject to reviewed Git fingerprints, and an active integration or fetch still blocks conflicting mutations.

The branches menu can browse its cached list and close while fresh repository checks are pending. Mutations remain disabled until those checks succeed. The current Git snapshot includes integration state, avoiding a second complete status/fingerprint scan; older cores retain the separate operation-state fallback. Remote-refresh scheduling after a successful mutation does not calculate another branch list before returning.

Verification on 2026-11-02 reproduced HEAD plus remote-ref events as `configurationChanged: true` before the fix. The watcher regression now requires zero source events for that case, then verifies both real source edits and configuration edits still arrive. Read-only baseline measurements on the representative workspace (three sequential samples, development core, no provider startup or fetch) found a 7.14 s workspace open including inventory validation, a 496.5 ms median full Git status and a 660.8 ms median operation-state request that repeated that status. A same-budget rerun after the change still took 7.64 s to open, with medians of 587.1 ms for status and 471.3 ms for operation state. Per-request timings vary; this change does not claim faster filesystem validation. The guarded improvements are structural: metadata-only changes cause zero source rescans, and a menu opening on the current core requests one full status rather than two. These are local observations, not a production latency guarantee. The fix removes the unnecessary rescan and duplicate request rather than weakening their validation; cold opens and genuine source/configuration changes still incur their required work.
