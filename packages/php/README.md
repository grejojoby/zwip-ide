# PHP Languages

PHP is a separately installed/enabled worker package. Built-in PHP highlighting works without the package. PHP scratch files are available; scratch files remain outside language analysis.

Build with `node packages/php/build.mjs` (Node 24.16.0). Install the resulting `dist/packages/php` directory using the IDE's package manager, or distribute it through the existing archive/catalog builder. Building does not install, enable or publish the package.

The package bundles its Node runtime, worker, grammar, checksums and dependency notices. It requires a local **PHP 8+ CLI with tokenizer**. `php` is resolved from the IDE process's PATH; alternatively launch the IDE with `ZWIP_PHP_BINARY` set to an absolute PHP executable path. No PHP interpreter is downloaded or bundled. A missing/incompatible interpreter fails startup explicitly. Parsing uses that interpreter's PHP version, with no php.ini/extensions loaded (`-n`); projects using newer syntax need a matching newer CLI.

## Supported scope

- `.php`, `.phtml`, `.php8` highlighting, PHP islands in HTML, comments, strings and heredoc/nowdoc.
- Syntax diagnostics for the current saved file or unsaved overlay using PHP's parser. Project code is tokenized, never executed; Composer scripts and project configuration are not executed.
- Declaration outlines (named classes, interfaces, traits, enums, functions, methods and the first name in a const declaration), workspace declaration search, name/variable/keyword completion and declaration-preview hover.
- Go to Definition returns matching declaration **candidates**; Find Usages returns matching identifier **candidates** including declarations. Both always report partial coverage. Comments and string contents do not become declaration or reference candidates.
- Composer roots and individual PHP files use generic discovery metadata. File contexts share one package worker. Analysis uses only the host's included file list; Git-ignored dependencies and excluded files are not indexed.
- Revision/generation checks, ordered overlay updates, close-to-disk behavior and refresh after workspace changes.

Namespaces, imports/aliases, Composer autoloading, dependency types, receiver types, inheritance and dynamic calls are not resolved. Same-name symbols can appear as candidates. Diagnostics cover syntax, not static types, missing includes, duplicate declarations or runtime errors. Formatting, rename, code actions, type/implementation navigation, hierarchy/call queries, framework support, run/test/debug and persistent indexes are unsupported.

Analysis is limited to 1 MiB per file and 2,000 workspace files, with a five-second workspace-analysis budget and 10,000 result limit; limits and failed files retain partial coverage with reasons. PHP subprocesses have a ten-second timeout and bounded output/memory. Completion returns at most 500 name candidates. Workspace files added or removed are picked up when the host refreshes the workspace/provider.

The parser integration follows PHP's [token_get_all documentation](https://www.php.net/token-get-all). No upstream language-server code or license-restricted intelligence is bundled.

Run `npm test -- tests/packages/php-service.test.ts tests/packages/php-package.test.ts tests/packages/syntax.test.ts src/editor/builtin-syntax.test.ts` with PHP 8+ on PATH (or set `ZWIP_PHP_BINARY`). These tests exercise the real interpreter and built worker; CI runners need PHP installed too.
