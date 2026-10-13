# Application license evidence

The application notice generator is offline. It collects original license/notice files from the installed npm packages actually present in the UI bundle, the production Cargo dependency graph, and the installed Rust standard library distribution. E2E automation is excluded.

Some published Rust crates omit license files from their archives. `provenance.json` binds these supplements to each installed crate's repository, version and `.cargo_vcs_info.json` commit. Every local file has a SHA-256 checksum, checked on each generation. Upstream files are preserved unchanged and excluded from formatting.

- Most supplements are repository license files at the exact published commit. The tauri-plugin texts came from a cached tauri-utils crate with the same repository commit.
- The objc2 repository's exact `LICENSE.md` supplies its licensing notice and links to MIT terms. `OSI-MIT.txt` preserves the four license paragraphs from that explicitly linked official page, decoding HTML entities. Its template placeholders are retained; no copyright holder or year was invented. The source HTML checksum and extraction explanation are recorded. The original objc2 licensing discussion is retained with it.
- The selectors repository has no standalone license file. Its original `lib.rs` explicitly identifies MPL 2.0 and its official URL; both that notice and Mozilla's versioned full license text are preserved.

Run `node scripts/application-notices.mjs` after a production Vite build. Missing original text, mismatched crate provenance or changed vendored bytes fails generation and prevents a distribution notice from being produced. The output is `dist/application-notices/`, bundled into the application as `notices/`. Downloadable package notices are generated separately.
