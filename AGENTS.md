# AGENTS.md

Think before coding. Prefer simple, surgical changes. Preserve the approved v1 requirements and report unsupported or incomplete capabilities honestly.

- Go binary: `/Users/grejo.j/.gvm/gos/go1.25.5/bin/go`.
- GOROOT: `/Users/grejo.j/.gvm/gos/go1.25.5/`.
- Always use that Go path directly; do not discover another Go installation.
- Always stage new project source files. Do not stage build output, caches or downloaded upstream source.
- The `goserving` representative workspace is read-only for implementation and benchmarking.
- Packages implement core contracts. Do not import language/framework implementation into the Rust workspace foundation.
- Preserve explicit query coverage and document-version preconditions. A failed provider is not a complete empty result.
- Every delivered implementation, fix, configuration or documentation change must update `src/content/updates.ts` in the same delivery. Follow the [update-history guide](docs/update-history.md): prepend a fresh permanent ID, preserve history, and group related changes without duplicating generated artifacts or rebuilds.
