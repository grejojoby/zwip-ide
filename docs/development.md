# Development guide

See the [README](../README.md) for the product overview and [implementation status](status.md) for current acceptance evidence. This is a personal macOS preview; passing service tests does not establish release qualification or production resource efficiency.

## Prerequisites

- Apple Silicon macOS. The build declares macOS 13.5 as its minimum to match the packaged Node runtime; only macOS 27.0.1 has been exercised.
- **Node.js 24.16.0 exactly.** Package builds enforce this pin; another Node 24 version is not accepted.
- Rust and Xcode Command Line Tools.
- Go 1.25.5 for Go package builds and its runtime tools. This checkout's configured Go binary is `/Users/grejo.j/.gvm/gos/go1.25.5/bin/go`, with GOROOT `/Users/grejo.j/.gvm/gos/go1.25.5/`.

The Go bootstrap and worker accept `ZWIP_GO` only as an explicit absolute executable path. On a different development machine, set it to that machine's Go 1.25.5 binary before building packages and launching the development app. They derive GOROOT from that executable and use `GOTOOLCHAIN=local`; they do not silently download or substitute a different Go toolchain. Repository agent work must follow the configured path in [AGENTS.md](../AGENTS.md). See the [Go package guide](../packages/go/README.md) for bootstrap and runtime details.

```sh
npm ci
npm run dev
```

## Build and install packages

```sh
npm run build:packages
```

This writes the Go, Web, React/Next, SQL, Redis and HTTP package directories under `dist/packages/`. In the app's Packages dialog, choose **Install directory…**, select a generated directory, then enable it. React/Next is a declarative extension requiring Web; install and enable Web first. Installation and activation are separate, and language workers start on demand. The application does not upgrade or rewrite your workspace's Go modules or TypeScript dependencies.

For local ZIP installation:

```sh
node scripts/package-catalog.mjs --archives-only
```

Choose **Install archive…** and select a ZIP from `dist/catalog/`. `archives.json` records SHA-256 digests for these local files; it is not a hosted catalog. To generate a remote catalog, supply an HTTPS location you control with `--base-url`. The generator creates files locally; it neither publishes them nor configures a public service. Packages contain executable code, so use catalogs and archives you trust.

## Build the application

```sh
npm run build
```

The build writes `target/release/bundle/macos/Zwip.app` and separate package assets under `dist/packages/`. Packages are not enabled implicitly. Application resources include notices and an inventory for the bundled dependencies; downloadable packages have their own notices.

Local builds use an ad-hoc resource signature. They have no Developer ID signature or notarization and are not ready for public distribution. Compile-time Rust dependencies retain their symbols to avoid an observed macOS 27 / Rust 1.95 procedural-macro loader failure; application release optimization remains enabled.

## Checks and native tests

```sh
npm run check          # TypeScript, lint, formatting and Rust static checks
npm test               # Frontend, Web and tool-service tests
cargo test --workspace # Rust services and disposable-repository tests
npm run test:go        # Pinned gopls fork integration tests
npm run build:e2e      # Native debug app with test-only automation
npm run test:e2e       # Real WKWebView application tests
```

Database integration tests use disposable data and real services when available. Check the test report for environment-gated skips; do not count skipped server tests as successful coverage. Native automation is an optional Cargo feature excluded from production builds. Its synthesized DOM input does not certify physical keyboard handling, IME or VoiceOver. Build production again after native-test builds when validating the distributable application and its notices.

For performance investigation:

```sh
npm run bench:workspace -- --workspace /path/to/project
node --test scripts/bench-native.test.mjs
node scripts/bench-native.mjs --help
```

The workspace benchmark measures services only. The native sampler attaches to an existing application PID and accounts for attributable helpers; see the [benchmark method](benchmark-method.md) for measurement boundaries. The representative `goserving` workspace is read-only. Use disposable copies for workflows that create files or change Git state.

## Workspace behavior

Save named commands and workspace-relative working directories in the Run panel. Select a saved configuration in the top bar to execute it; its selection survives restart. Commands do not start automatically when reopening a workspace. Optional Go build profiles belong in `.zwip.json`; see the [profile contract](protocol.md). Independent modules remain independent.

Documents are edited immediately in CodeMirror. Ordered UTF-16 deltas update Rust's versioned mirrors. Workspace edits are reviewed, validated together and applied to recoverable buffers; explicit save writes them to disk. External changes never silently replace dirty buffers.

## Repository structure

| Location               | Responsibility                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------ |
| `src/`                 | Editor shell, navigation, tool UI and shared TypeScript contracts                    |
| `src-tauri/`           | Native application entry and Tauri configuration                                     |
| `crates/ide-core/`     | Documents, SQLite recovery, workspaces, package supervision, Git, tasks and terminal |
| `packages/go/`         | Pinned gopls overlay, module contexts, Go navigation and tools                       |
| `packages/web/`        | TypeScript language service worker and HTML/CSS adapters                             |
| `packages/react-next/` | Declarative project Next.js integration                                              |
| `packages/tools/`      | Installable SQL, Redis and HTTP workers                                              |
| `tests/`               | Semantic fixtures, service checks and native application scenarios                   |
| `site/`                | Standalone product landing page; see its [guide](../site/README.md)                  |
| `docs/`                | Protocol, project constraints and release acceptance status                          |

The Rust foundation owns generic workspace and package contracts. Language and framework implementations belong in packages. Every delivered change includes a fresh entry in `src/content/updates.ts`; follow the [update-history guide](update-history.md).

## Reference sources

[Tauri sidecars](https://v2.tauri.app/develop/sidecar/), [CodeMirror API](https://codemirror.net/docs/ref/), [gopls workspace model](https://go.dev/gopls/workspace), [TypeScript project loading](https://www.typescriptlang.org/tsconfig/disableReferencedProjectLoad.html).

## Product identity and fresh setup

The product, npm package and desktop Cargo package are named **Zwip**. The desktop binary is `zwip`, and macOS builds produce `Zwip.app`. The tagline is “Modern lean IDE for faster productivity.”

New installations use the application identifier `dev.zwip.ide`, `zwip.*` preference keys, Zwip Keychain services, `.zwip.json` workspace configuration and `ZWIP_*` environment variables. `ZWIP_DATA` explicitly selects an application data directory. The source repository is `grejojoby/zwip-ide`; clone instructions use `zwip` as the local checkout name. Screenshot pixels are unchanged captures from before the current branding, with their original provenance retained.

Zwip starts with a fresh application store. Previous application data, preferences, credentials and workspace configuration are not imported or used as fallback. Existing data is left untouched. Install the desired packages, configure connections and settings, and create `.zwip.json` profiles as needed.

## Continuous integration and releases

`.github/workflows/ci.yml` runs `npm run check` and `npm test` on pushes to `main` and on pull requests, using a macOS Apple Silicon runner with Node 24.16.0, Go 1.25.5 (passed to package builds through `ZWIP_GO`) and stable Rust.

`.github/workflows/release.yml` runs when a `v*` tag is pushed. The tag must equal `v` plus the `package.json` version. It tests, runs `npm run build`, zips `Zwip.app` with a SHA-256 file, and creates a GitHub **pre-release** with both attached. The build is ad-hoc signed and not notarized, so macOS Gatekeeper requires right-click → Open on first launch.

```sh
git tag v0.1.0
git push origin v0.1.0
```

These workflows have not yet run on GitHub-hosted runners; confirm the first run before relying on them.
