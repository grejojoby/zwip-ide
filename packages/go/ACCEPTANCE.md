# Go provider acceptance evidence

`node packages/go/build.mjs test -race` passes on the configured Go 1.25.5 SDK. The navigation matrix has **30 named cases**. The fixture source contains annotated expected positions before queries run; no provider output generates its own oracle.

| Cases     | Behavior                                                                            | Assertion                                                                        |
| --------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 01–04     | Function definition, references including tests, direct incoming/outgoing calls     | Exact physical target positions                                                  |
| 05–06, 28 | Type aliases and alias references                                                   | Exact positions; type definition preserves the declared alias                    |
| 07–12     | Type parameters, generic functions, generic fields and keyed literals               | Exact positions                                                                  |
| 13–19     | Globals, constants, local shadowing and references                                  | Exact positions, excluding shadowed names                                        |
| 20–26     | Embedded types, promoted methods, interface methods, constraints and variable types | Exact positions                                                                  |
| 27, 29–30 | Implicit implementations and method-set subtype/supertype relations                 | Required named candidates with relationship labels; alias spellings may coalesce |

Separate fixtures verify prompt asynchronous initialization, two-loader concurrency, interactive context priority, shutdown while indexing, 33 independent modules with 32 unopened consumers; physically distinct local replacements; private/named signature identity; unsaved and new-file overlays; explicit query scopes; cancellation; stale generations; missing imports/type errors; vendor navigation and import organization; ordinary rename federation and conservative method-rename blocking; disk invalidation; clean document close; workspace symbol truncation; and explicit `go.work` membership. A local-file module proxy fixture proves that readonly Go workspace commands would write `go.work.sum` without the protective overlay and cannot write it with protection enabled.

These are source-level correctness fixtures, not proof of exhaustive runtime dispatch or native interaction quality. Cross-context structural candidate searches remain explicitly partial where upstream indexes cannot cover function-local types or generic certainty.

The [goserving oracle](qualification/goserving-oracle.json) separately defines 12 targets from real tracked source. Run `node packages/go/qualification/qualify.mjs --workspace /absolute/path/to/goserving` after building the package. It includes all tracked Go module contexts, hashes tracked Go/configuration files plus potentially created sum/work files, and reports target match separately from completeness. It uses the normal module cache with readonly project configuration; `--offline` disables dependency downloads when desired. Missing dependencies remain visible and qualification may fail. Host C dependencies must be configured through the worker environment; no global configuration is changed. The report is a worker correctness observation, not a UI or comparative resource benchmark.

Run/test/subtest/coverage and real Delve noDebug transport tests pass. Native breakpoint/stack/variables/continue validation remains unpassed on this host; see [tool validation details](TOOLS.md).

## Real-workspace result on 2026-10-12

The latest [goserving result](qualification/goserving-result.json) passes all 12 expected target sets with complete results across all 33 Go module contexts. Every guarded Go/configuration hash remained unchanged. Initialization acknowledged in 645 ms; background context loading settled in 71.3 seconds. Individual first-query observations ranged from 6 to 875 ms; these are not latency percentiles or UI measurements.

The run used normal module-cache dependency resolution and a process-local `PKG_CONFIG_PATH=/opt/homebrew/opt/pcre/lib/pkgconfig` for the already-installed arm64 PCRE 8.45 library. Earlier offline/sandbox runs correctly remained partial because of cache access, uncached modules and the missing pkg-config path. No system installation, global environment change or workspace source edit was made.
