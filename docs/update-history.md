# Maintaining update history

`src/content/updates.ts` is the canonical history shown by the application's What's New popup. It exports the readonly `updates` array of `UpdateEntry` values, newest first. Update the data in the same delivery as every implementation, fix, configuration or documentation change, including changes to these project rules.

The popup automatically opens once after each update. Its seen state depends on the entry's permanent ID, not only the application version. A new delivered change therefore needs a new ID even while several development updates share version `0.1.0`. Reusing an already-seen ID can hide the update from the user. Read status is stored once for the application, across workspaces. Got it, the close button and Escape all acknowledge the latest entry. If another dialog or workspace transition is active at startup, the automatic popup waits for it to finish; it remains available from the status bar and action search.

## Entry format

Each entry contains `id`, `version`, `date`, `title`, `summary` and a nonempty `changes` array. Each change contains `type`, `title` and `description`. Valid types are `added`, `improved`, `fixed`, `removed` and `maintenance`.

An example entry for the update-history feature follows. Future deliveries must use their own ID and date, and the version actually present in `package.json`.

```ts
{
  id: '2026-10-13-update-history',
  version: '0.1.0',
  date: '2026-10-13',
  title: 'Update history',
  summary: 'See what changed after each update.',
  changes: [
    {
      type: 'added',
      title: "What's New popup",
      description: 'The popup opens once after each update and includes earlier changes.',
    },
    {
      type: 'maintenance',
      title: 'History stays current',
      description: 'Project rules require each delivered change to include an update note.',
    },
  ],
}
```

## Adding a delivery

1. Review the completed changes and group related work into one new entry. Include documentation and configuration changes as appropriate `maintenance` items. Adding the history note itself does not require a second entry; generated artifacts and rebuild-only work do not warrant duplicate entries.
2. Choose a fresh, unique `YYYY-MM-DD-slug` ID and the delivery date in `YYYY-MM-DD` format. Read `package.json` for the current version; do not invent a release version or bump it solely to make the popup appear.
3. Prepend the entry to `updates`. Preserve older history and IDs. When dates are equal, place the most recently delivered entry first, rather than sorting slugs alphabetically. Never rename an existing ID or fold a new change into an old entry to avoid a new notification.
4. Write short, user-oriented titles and descriptions. State relevant limitations; do not claim unmeasured performance improvements or unsupported capabilities. Exclude credentials, personal/internal filesystem paths and sensitive project details.
5. Check unique IDs, valid dates, current version, allowed change types and ordering. Run the relevant history/UI tests and existing project checks; `npm test`, `npx tsc --noEmit` and `npm run check` are available. For popup behavior changes, verify first display, dismissal, a later update ID and access to older history.
6. Review the implementation and note together before delivery. Stage new project source files, including new rules or documentation; keep build output, caches and downloaded upstream source out of staging.

`AGENTS.md` links this guide for all project work. `.cursor/rules/update-history.mdc` applies the same requirement with `alwaysApply: true`.
