# Product landing page

A standalone, responsive static site for Zwip, with the tagline “Modern lean IDE for faster productivity.” It uses HTML, CSS and a small TypeScript module for the Git screenshot gallery and copy button. It has no React runtime, analytics, external font requests or API dependencies.

## Run locally

From the repository root, after `npm ci`:

```sh
npm run dev:site     # http://127.0.0.1:1421
npm run build:site   # Static output in dist/site
npm run preview:site # http://127.0.0.1:1422; requires a build first
```

The site has a separate Vite configuration and output directory. Desktop development and packaging commands are unchanged. TypeScript and lint checks include the site's script and configuration; the root formatting check includes its source and documentation.

The output uses relative asset paths, so it can be served at a domain root or a subdirectory such as `/zwip/`. Serve the contents of `dist/site` with a static HTTP server. No deployment, domain or GitHub Pages configuration is assumed or created. GitHub links target the repository's configured origin and its `main` branch; the linked source must be pushed before those pages are publicly accessible.

## Visual direction

The midnight and blueprint-blue palette follows the IDE’s blue accent. The compact technical navigation, oversized centered wordmark, orbital composition, and numbered feature sections are an original adaptation of the layout studied at [ArtCraft](https://getartcraft.com/). No ArtCraft graphics, text, or code are included. Decorative orbit notes are illustrative; the product screenshots remain unmodified application captures from before the Zwip rebrand.

## Content and assets

- `index.html`: product narrative, current capabilities, setup and preview limits. Keep its GitHub anchors in sync with the root README.
- `styles.css`: responsive layout, self-hosted typography, keyboard focus and reduced-motion support.
- `main.ts`: native button controls with selected state, live captions and clipboard feedback. Core content, screenshot links and FAQs work without JavaScript.
- `public/images/`: unmodified real application screenshots. See [asset provenance](public/images/README.md).
- `public/fonts/`: Instrument Sans and Instrument Serif, redistributed with their SIL Open Font License files. See [font provenance](public/fonts/README.md).

The page explicitly identifies the personal preview. Do not introduce unmeasured CPU/memory savings, unsupported feature-completeness claims, a download button without a published binary, or a license the project has not adopted. Every delivered site/docs change also needs a fresh app [update-history entry](../docs/update-history.md).

## Verify changes

Run `npm run build:site`, `npx tsc --noEmit`, `npm run lint` and `npm run format:check`. Inspect the built page at desktop, tablet and narrow mobile widths. Check the gallery, full-size images, anchor links, keyboard focus, FAQ disclosures, copy feedback, reduced motion and browser console. Test a subdirectory URL if changing asset paths.
