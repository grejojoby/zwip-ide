# Go run, test, coverage and debug tools

The JSONL worker accepts `tool.request` with `{method, params}`. The outer JSON-RPC ID correlates requests. Responses contain `state`, `reasons` and method-specific data. Tasks run saved source: unsaved documents in any included module block execution because that module may be a local replacement dependency. The host should save and synchronize documents before starting a task. The configured absolute Go SDK is used without a shell; module commands preserve readonly or vendor mode.

| Method          | Parameters                                                             | Result                                                              |
| --------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `run.start`     | `{contextId?, path?, package?, programArgs?}`                          | `job`                                                               |
| `test.start`    | `{contextId?, path?, package?, programArgs?, testPattern?, coverage?}` | `job`                                                               |
| `job.poll`      | `{jobId, after?}`                                                      | `job`                                                               |
| `job.cancel`    | `{jobId}`                                                              | `job`                                                               |
| `debug.start`   | `{contextId?, path?}`                                                  | `sessionId`, DAP `capabilities`                                     |
| `debug.request` | `{sessionId, command, arguments}`                                      | DAP `response`                                                      |
| `debug.poll`    | `{sessionId, after?}`                                                  | `sessionId`, `status`, `cursor`, `events`, optional `droppedBefore` |
| `debug.stop`    | `{sessionId}`                                                          | `status: "stopped"`                                                 |

Supply `contextId` or a canonical absolute `path`; a `.go` file selects its package directory. `package` defaults to `.` and may be a relative directory or `./...` for tests. A test pattern uses Go's `-run` syntax, including subtest paths. `programArgs` are literal argv elements; test arguments follow `-args`. No shell expansion occurs.

Named build profiles use their full context ID, such as `service/go.mod#integration`. A path without `contextId` keeps the default profile. Run, test and debug commands preserve the selected profile's target, build tags, cgo setting and explicit `go.work`. Cross-target execution is rejected before launching a child; compile-only cross-target commands are not implemented. Debug launch environment overrides cannot replace the selected target or explicit profile settings.

`job` contains `{id,status,cursor,events,exitCode?,coverage?,reasons,droppedBefore?}`. Status is `running`, `completed`, `failed` or `canceled`. Each event has `{sequence,kind,stream?,text?,test?}`; `test` is the original `go test -json` event, including subtest names and package statuses. A successful start only confirms process creation; inspect final status and exit code. Compile failures are real failed jobs.

Coverage contains `{percent,files:[{path,fileHash,coveredStatements,totalStatements,percent,blocks:[{range,count,statements}]}]}`. Ranges use zero-based UTF-16 coordinates. The host must verify file hashes before drawing overlays. Workspace changes while tests run suppress coverage with an explicit reason. Profiles and temporary files are removed after collection.

Polling uses monotonically increasing cursors. Event history is capped at 2,000 events and approximately 2 MiB per job/session; `droppedBefore` reports evicted history. Completed jobs are retained up to 32 entries and stopped debugger sessions up to 16. Cancellation kills the owned process group; reinitialization, JSONL shutdown notifications, input closure and SIGTERM clean up owned children. Debugger shutdown first requests disconnect with termination, then kills its group after a bounded grace period.

## Delve transport

The package builds **Delve v1.27.2** with Go 1.25.5. Both upstream checksum records and `DELVE-LICENSE` are shipped; `bin/dlv` is covered by the manifest checksum. A private Unix-domain socket connects the worker to Delve; the adapter is not exposed on a TCP debug port. Delve's macOS backend may itself use a loopback connection to Apple's debugserver.

`debug.start` starts and initializes the adapter. Send `launch` concurrently while polling for `initialized`; set source breakpoints, send `configurationDone`, then await launch. DAP positions are **one-based** and must be converted by the UI. `stackTrace`, `scopes`, `variables`, `evaluate`, stepping, continue and pause use standard DAP requests and events. Supported launch modes are `debug` and `test`. A source-file program selects its containing package, preserving sibling files. The worker enforces the selected module's cwd, SDK/environment and readonly build flags, and directs compiled output to its temporary directory. Application environment variables are allowed; build-setting overrides such as `GOFLAGS`, `GOENV` and `GOEXPERIMENT` are ignored in favor of the selected context. Attach and arbitrary externally supplied executables are unsupported. `debug.stop` terminates owned debuggees; it does not detach them to run unattended.

`ZWIP_DLV` can explicitly override the debugger with an absolute path for development. `ZWIP_DAP_LOG=1` forwards verbose adapter/backend diagnostics into debug output; it is off by default and may include launch paths, arguments and environment values.

## Validation status on 2026-10-12

Passing: Go subtests, statement coverage and ranges, source-file package selection, argv/output, process-group cancellation, JSONL tool routing, framing rejection, full Go race suite; real Delve initialization, noDebug launch, output, terminated event and cleanup under the race detector.

**Native backend proof passes outside the execution sandbox.** The shipped Delve v1.27.2 stopped at the verified source breakpoint, returned the expected stack line and local `value = 42`, evaluated a watch expression, stepped across two source lines, observed the updated `value = 43`, paused/resumed the process, continued to its terminated event and cleaned up its adapter. The expanded proof and the separate noDebug/framing tests passed under the race detector; see [the qualification record](qualification/debugger-result.json). This qualifies the real backend; native IDE UI interaction is tracked separately.

Earlier runs stalled in Apple's debugserver around `task_for_pid`; the original cause remains unproven. The current successful run required no global security change: Developer mode was still disabled, the user remained in `_developer`, and Apple's debugserver signature was valid. These facts do not support telling users to disable system protections or assuming Developer mode is the cause of a launch failure. Delve and Apple document that macOS may request debugger authorization; report an actual denial if one occurs.

Run `node packages/go/build.mjs debug-test -race -run TestDelveBreakpointStackVariablesContinue -v` to repeat the native proof. Run `node packages/go/build.mjs debug-test -race -run 'TestDelveNoDebug|TestDAP' -v` for the separately passing transport lifecycle. The normal test command explicitly skips real Delve tests unless `ZWIP_DLV` is supplied; it does not represent native debug verification.

The historical JSON qualification records retain the actual commands and paths from their recorded runs, including the executable's former name. The commands above now target `./cmd/zwip-go`; the navigation qualification runner uses `bin/zwip-go`. Renaming source and executables does not retrospectively requalify those historical runs.

Primary references: [Delve DAP protocol](https://github.com/go-delve/delve/blob/v1.27.2/Documentation/api/dap/README.md), [supported Go versions](https://github.com/go-delve/delve/blob/v1.27.2/pkg/goversion/compat.go), [Apple debugging entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.cs.debugger).
