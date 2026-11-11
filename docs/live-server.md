# Live Server

Live Server is an optional tool package for previewing static HTML, CSS and JavaScript in your browser. It has no dependency on the Web language package and starts only when you open its controls.

## Install and use

1. Build the packages with `npm run build:packages`. Alternatively, build just this tool with `node --input-type=module -e "import('./packages/tools/build.mjs').then(m => m.buildToolsPackages({ ids: ['live-server'] }))"`.
2. Open **Packages → Install directory…**, select `dist/packages/live-server`, then enable **Live Server**. Release catalogs include it when generated from the new package build; an older published catalog may not list it yet.
3. Click **Live Server** in the status bar, or search for **Live Server: start or stop a local web server** in action search.
4. Enter a folder inside your workspace (`.` by default, or `public`, for example) and a port (`5500` by default). Port `0` selects an available port. Click **Start server** to open the preview in your default browser. If browser opening fails, the running URL remains visible and **Open in browser** retries it.
5. Save changes to refresh open HTML pages automatically. **Stop server** releases the port. Closing the dialog leaves the server running; reopening restores its status. Disabling or restarting the package, switching workspace, a full workspace refresh, or closing the IDE window stops its server.

## Behavior and boundaries

- One server runs per workspace window. It binds only to `127.0.0.1`, with no LAN sharing, HTTPS, proxying, backend execution, framework compilation, SPA history fallback or directory listing.
- Folder requests serve `index.html`; nested folders redirect to a trailing slash so relative assets resolve. Unknown files return 404. Common web assets have their usual content types; other files use `application/octet-stream`. Responses bypass browser caching.
- Saved file changes trigger a full page reload through an injected EventSource client. Files on disk are never modified. HTML responses are limited to 8 MiB. Pages with a Content Security Policy that blocks inline scripts or EventSource need manual refresh. Watch failures are shown in the dialog and require a restart.
- The server accepts GET and HEAD. Traversal, hidden paths, `node_modules`, and symlinks pointing outside the chosen folder are blocked. Host, Origin and browser fetch metadata checks reject foreign origins. Other visible files in the chosen folder are available to local clients, so choose the folder containing the preview assets.
- All server code stays in the optional Node worker; the Rust foundation only advertises the package through its existing package list. The package owns its Node runtime, checksums and third-party notices, like the other tool packages.

## Worker contract and verification

The existing `tool.request` envelope routes to package ID `live-server`. Methods are `status`, `start` (`directory?: string`, `port?: number`), `stop`, and `open` (open the worker's current URL in the default browser). Status returns `running`, plus `directory` and `url` when running and `warning` if watching fails. Startup failures return errors rather than successful stopped results. No server starts merely from installing or enabling the package.

Server integration tests cover static files, HEAD, reload delivery after a disk save, input validation, occupied ports, stopping/reusing a port, traversal, symlink escapes and foreign origins. UI tests cover optional installation, start/open/stop, start and browser errors, and restoring running status. The package test builds the actual worker, verifies its manifest/runtime checksums, exercises JSON-line requests and confirms shutdown releases its socket. Existing package lifecycle checks cover host-owned worker shutdown.
