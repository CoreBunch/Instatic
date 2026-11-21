# Site Import

`src/admin/modals/SiteImport` is the canonical import surface. It routes static-site bundles (HTML pages, CSS files, images, fonts, JS) through `src/core/siteImport`, and routes CMS-exported site-transfer ZIP bundles through the CMS transfer endpoints for full import/export parity.

The static-site pipeline has two parts: a pure analysis function (`buildImportPlan`) that produces an `ImportPlan` preview, and an async commit function (`commitImportPlan`) that uploads assets and writes to the store. CMS bundle imports keep their native semantics: validate the `SiteBundle`, preview against `/admin/api/cms/import/preview`, resolve any row slug conflicts in the shared Conflicts step, then apply through `/admin/api/cms/import` or `/admin/api/cms/import/archive`. The modal uses the same Review category navigator and Import progress surface for CMS bundles, so tables, media, folders, redirects, conflict resolution, and completion all live in the same picker pattern as HTML/CSS/media imports.

WebKit-prefixed CSS properties and declarations containing `var()`, `env()`, `clamp()`, `min()`, or `max()` pass through the shared CSS substitution encoder before CSSOM parsing. This preserves their authored values in both browser and headless imports, including centered section padding and responsive wrapper widths. The decoder restores the original property names before storage.

---

## TL;DR

- Entry: global admin-shell modal, opened from Spotlight or workspace actions. Drop files, a folder, a static `.zip`, or a CMS-exported `.zip` bundle. Static files and CMS bundles both use the four-stage modal (Drop → Review → Conflicts → Import, with completion shown inside the Import stage); Conflicts is skipped when there is nothing to resolve.
- `buildImportPlan({ fileMap, currentSite, options })` — pure, synchronous — produces an `ImportPlan` with pages, style rules, kept stylesheet files, media, color tokens, custom fonts, Google font install requests, font tokens, scripts, and script npm dependencies inferred from known ESM CDNs.
- **Per-stylesheet import modes:** each top-level linked stylesheet either converts to editable style rules (default) or imports verbatim as a page-scoped `SiteFile` stylesheet (`options.stylesheetModes`, picked in the Review step). There are no generated scope classes — page isolation comes from the kept file's runtime scope.
- **Stylesheets no page links** import verbatim as site-wide `SiteFile` stylesheets (all-pages scope). An import needs no page: a lone `.css` file is a valid import. See "Stylesheets no page links".
- **Plugin packages are not sites.** A drop with `plugin.json` at its root stops at the Drop step with a notice and a button to the Plugins page (`detectPluginPackage`).
- `commitImportPlan(plan, adapter)` — uploads assets, then wraps all store writes in a single `adapter.commit` call → one Cmd+Z reverts the whole import.
- Static imports load the current CMS draft into the editor store on demand when launched outside `/admin/site`; if no draft exists, the modal creates an empty site before analysis. After completion, **Open site** selects the first imported page and navigates through the admin router to `/admin/site?table=pages&row=<pageId>`, including when the import began in another workspace.
- Conflict resolution: rename with a numeric suffix (default), overwrite, skip, or custom-rename — per page slug, per class name, per design token (colour / font CSS variable), and per cross-stylesheet class row (a sheet whose rules would reach pages that do not load it, or a definition no global order can keep faithful), with category-level bulk actions. Token renames rewrite `var(--x)` references, and declarations of the same variable in other rules, so imports stay faithful.
- Re-import: scripts and kept stylesheets whose path the site already has (`FileConflict`) and media the library already holds by content hash (`MediaConflict`) default to reusing what is there. See "Re-importing a site".
- What imports: pages (with their `<head>` metadata as page SEO settings), linked CSS plus unconditional local CSS `@import` graphs, `kind:'class'` and `kind:'ambient'` style rules, stylesheets kept as page-scoped files, `@keyframes`, uploadable media/font files, root CSS color tokens, root CSS font tokens, `@font-face` families, known external font stylesheet imports, safe extra HTML attributes on base modules, body-level classes/attributes/style metadata, bare DOM text nodes in mixed content, and executable HTML scripts as page-scoped runtime scripts. Module-script imports from known npm CDNs are rewritten to bare package imports and added to the site dependency manifest.
- CMS bundle import preserves selected exported tables, rows, optional site shell, media, folders, and redirects using the same merge strategies as site transfer (`replace`, `merge-add`, `merge-overwrite`). When the bundle marks rows published but carries no published version of them, they arrive as drafts; the completion step and success toast give the count (`ImportResult.rowsImportedAsDraft`, see [site-transfer.md](site-transfer.md) → "Rows the import cannot publish").
- HTML forms import through the shared HTML importer as first-class form primitives (`base.form`, controls, labels, submit buttons), not as custom containers.
- Imported self-hosted `@font-face` files retain their `font-display` descriptor in the native font library. An omitted descriptor imports as CSS's `auto`; fonts installed through other paths continue to default to `swap`.
- What cannot be modeled: `@layer`, conditional local CSS `@import`, and arbitrary external `@import` — surfaced as warnings when the CSS engine exposes them, never silently dropped.
- Headless: `src/core/siteImport/` carries no admin, React, or server imports (gated by `siteImport-headless.test.ts`).

---

## Where the code lives

```text
src/core/siteImport/
├── index.ts             — public barrel
├── types.ts             — shared plan types: FileMap, PagePlan, ImportPlan, ImportResult, error classes
├── warnings.ts          — ImportWarning and its kinds
├── conflictTypes.ts     — ConflictResolution + one shape per conflict category (page, rule, token, cross-sheet class, file, media)
├── ingestInput.ts       — normalize input(s) → FileMap (loose files / folder / .zip)
├── pluginPackage.ts     — detectPluginPackage: a FileMap with a root plugin.json is a plugin, not a site
├── stylesheetPlan.ts    — catalogue linked sheets by import mode; flatten kept sheets and unlinked (site-wide) sheets
├── classifyFiles.ts     — extension/MIME → FileRole: html | css | js | image | font | binary | meta
├── htmlPagePlan.ts      — per-HTML-file plan: parse body via importHtml, derive title + slug, resolve <link> refs, and preserve executable scripts
├── headSeo.ts           — extractHeadSeo: the rest of <head> (meta, icons, social cards, links, JSON-LD) → PagePlan.seo; normalizeHeadSeoUrls for its files
├── cssToStyleRules.ts   — single-file CSS → StyleRule[] / @keyframes raw rules + AssetRef[] + warnings
├── colorTokens.ts       — extract root custom-property color tokens from :root/html/body rules
├── fontTokens.ts        — extract root --font-* custom properties as ImportFontToken[] from :root/html/body rules
├── fontImports.ts       — resolve trusted Google CSS2 @import rules into installed-font requests
├── scriptDependencies.ts — rewrite known npm ESM CDN imports in module scripts into bare package imports + dependency requests
├── scriptOrder.ts       — merge every page's script document order into the one priority sequence the runtime sorts by
├── cssImports.ts        — expand unconditional local CSS @import graphs while preserving each source path
├── classCascades.ts     — cross-sheet class semantics: detect leaking and divergent class definitions as explicit conflicts; shared-utility vocabulary
├── classCascadeResolution.ts — apply confine (rename) / skip / overwrite to leak and divergent rows; enforce one bindable class rule per name
├── classUsage.ts       — which classes each imported page uses: node class tokens, classes in inline SVG markup, and classes its scripts may put on elements
├── mimeTypes.ts         — extension → MIME fallback for FileMap entries that carry no MIME type (e.g. ZIP)
├── assetPlan.ts         — normalise URL props/HTML attributes in node fragments + CSS/@keyframes url(); resolve @font-face; collect assets
├── assetResolver.ts     — resolveAndRecord: one imported URL → FileMap key (+ upload plan, unresolved-asset warning)
├── applyAssetRewrites.ts — patch fragment props + CSS/@keyframes url() with new media URLs (post-upload)
├── linkRewrite.ts       — rewrite intra-site <a href> to cms:page:<id> refs
├── conflicts.ts         — detect page-slug + class-name + design-token collisions; re-check typed routes (withPageSlugs); apply resolutions (incl. var(--x) rewrites)
├── fileConflicts.ts     — site-file collisions (scripts + kept stylesheets) and their state from the file's importRecord
├── importOrder.ts       — mergeImportOrder / prioritiesForOrder: an import's scripts or kept sheets merged into the site's load order
├── mediaConflicts.ts    — hash planned assets; turn library hash matches into MediaConflicts (the one plan step that needs the server)
├── siteFilePaths.ts     — importedSiteFilePath / uniqueSiteFilePath / importSourceHash / siteFileImportRecord: where a script or kept sheet lands and the record it carries (shared by detection and the store commit)
├── tokenNames.ts        — settle the emitted name of every imported colour + font token (authored → emitted renames)
├── varRefs.ts           — rename a custom property across imported rules, inline styles and @keyframes (var(--x) refs + --x declarations)
├── adapter.ts           — SiteImportAdapter + SiteImportTransaction interfaces (the ONE transaction contract; the editor store implements it directly)
├── paths.ts             — dirname/joinPaths for FileMap-relative path resolution
├── planCss.ts           — single CSS-source parse path (external sheets + per-page inline <style>) feeding shared plan accumulators
├── buildPlan.ts         — buildImportPlan: pure analysis orchestrator, one named function per phase
└── commitPlan.ts        — commitImportPlan: upload → rewrite → one atomic adapter.commit, one named function per entity kind

src/admin/modals/SiteImport/
├── index.ts
├── SiteImportModal.tsx          — canonical import wizard shell + CMS bundle router
├── SiteImportFooter.tsx         — shared wizard footer actions
├── SiteImportModal.module.css
├── steps/
│   ├── DropStep.tsx             — full-modal drop zone (files, folder, .zip) + plugin-package notice
│   ├── AnalyzeStep.tsx          — category navigator (left) + detail pane (right) for static imports
│   ├── DetailHead.tsx           — detail-pane header (title, description, All / None bulk links)
│   ├── StylesheetModeRows.tsx   — per-linked-stylesheet import-mode picker
│   ├── SiteStylesheetRows.tsx   — include switch per stylesheet no page links
│   ├── CmsBundleAnalyzeStep.tsx — category navigator (left) + detail pane (right) for CMS bundles
│   ├── ConflictsStep.tsx        — page-slug + class-name + design-token conflict resolution rows
│   ├── CmsBundleConflictsStep.tsx — row slug conflict resolution for CMS bundles
│   └── ImportStep.tsx           — determinate progress surface + complete/failed states
└── shared/
    ├── createSiteImportAdapter.ts  — wires adapter to editor store + media API
    ├── useCmsBundleImport.ts       — CMS bundle parse/preview/import flow
    ├── cmsBundleFlow.ts            — CMS bundle selection counts + conflict-resolution helpers
    ├── ConflictRow.tsx             — single slug / class-name / token-variable conflict row with resolution picker
    ├── ImportStepper.tsx           — shared four-stage progress rail (Review + Import)
    └── importProgress.ts           — RunProgress model used by ImportStep
```

---

## Data flow

```text
User drops files / folder / static .zip / CMS bundle .zip
            │
            ├─ valid CMS bundle → previewSiteBundle → Review navigator
            │                                      │
            │                                      ├─ row slug conflicts? → Conflicts step
            │                                      └─ ImportStep → importSiteBundle/importSiteBundleArchive(strategy, selection)
            │
            ▼
    ingestInput(input)
            │  FileMap: { files: Record<path, {bytes, mimeType}> }
            │
            ├─ detectPluginPackage(fileMap) → root plugin.json? stop at Drop, point at Plugins
            ▼
    classifyFiles(fileMap)
            │  ClassifiedFile[] — each file has a FileRole
            ▼
    ┌── per HTML file ──────────────────────────────────────────────┐
    │   makeHtmlPagePlan(path, html, fileMap)                       │
    │   → PagePlan { source, title, slug, linkedCssPaths, scripts, │
    │               nodeFragment (via @core/htmlImport),            │
    │               seo (via extractHeadSeo) }                      │
    └───────────────────────────────────────────────────────────────┘
            │
    expandLinkedCssImports(linkedCssPaths, fileMap)
            │  follows unconditional local @import rules recursively
            │  imported CSS paths are added to each page's cascade list
            ▼
    ┌── per expanded linked CSS file ─────────────────────────────────┐
    │   extractGoogleFontImports(css)                                │
    │   → ImportGoogleFont[] install requests for trusted CSS2 imports│
    │                                                                │
    │   cssToStyleRules(css, { breakpoints })                        │
    │   → rules[], assetRefs[], conditions[], fontFaces[]            │
    │                                                                │
    │   extractRootColorTokens(rules)                                │
    │   → rules (minus :root color props) + ImportColorToken[]       │
    │                                                                │
    │   extractRootFontTokens(rules)                                 │
    │   → rules (minus :root --font-* props) + ImportFontToken[]     │
    └────────────────────────────────────────────────────────────────┘
            │
    collectUnlinkedStylesheets(cssPathsNoPageLinks, fileMap)
            │  CSS no page links → site-wide RawStylesheetSource (pageSources: [])
            ▼
    detectCrossSheetClassConflicts(pagePlans, cssFileResults, existingClassNames)
            │  flags DIVERGENT same-named class definitions across page cascades
            │  as explicit conflicts (default: rename with suffix) — applied later
            │  by applyConflictResolutions, never silently
            ▼
    buildAssetPlan(pagePlans, cssFileResults, fileMap, rawStylesheetSources)
            │  normalizes url() in node props, HTML attributes, CSS values, raw @keyframes
            │  CSS, and kept-stylesheet text to FileMap keys; after exact and
            │  punctuation-insensitive misses, a unique path suffix can match
            │  files stored below an exporter-specific archive directory
            │  resolves @font-face → ImportFontFamily[]
            │  flattens kept stylesheets (mode 'file') → ImportStylesheet[]
            │  collects deduplicated asset list
            ▼
    detectConflicts(currentSite, pagePlans, styleRules, colorTokens, fontTokens, scripts, stylesheets)
            │
            ▼
    ImportPlan
            │
    (wizard) hashImportAssets → POST /media/lookup → detectMediaConflicts
            │  media the library already holds → MediaConflict (default: reuse)
            ▼
    wizard preview (AnalyzeStep → withPageSlugs on Continue → ConflictsStep)
            │
            ▼
    commitImportPlan(plan, adapter)
      Step A: upload assets via adapter.uploadAsset (per-asset try/catch)
      Step B: applyAssetRewrites(plan, rewriteMap) — swap FileMap keys → media URLs
      Step C: adapter.commit(tx) — single atomic store mutation:
                tx.addConditions / tx.addColorTokens / tx.overwriteColorTokens / tx.addScripts
                tx.addFonts / tx.addFontTokens / tx.overwriteFontTokens
                tx.putStyleRule / tx.overwriteStyleRule
                tx.addPage / tx.overwritePage / tx.addStylesheets
            │
            ▼
    ImportResult → ImportStep complete state (summary + per-category counts)
```

---

## The `ImportPlan` shape

```ts
interface ImportPlan {
  pages:           PagePlan[]
  styleRules:      NewStyleRule[]
  styleRuleSources: string[]   // index-aligned with styleRules: source CSS path per rule
  fonts:           ImportFontFamily[]
  googleFonts:     ImportGoogleFont[]
  fontTokens:      ImportFontToken[]
  conditions:      ConditionDef[]
  assets:          ImportAsset[]        // { sourcePath, mimeType, bytes, altText? }
  colors:          ImportColorToken[]
  scripts:         ImportScript[]
  linkedStylesheets: LinkedStylesheet[]   // every top-level linked sheet + its import mode
  stylesheets:     ImportStylesheet[]     // sheets imported as files: kept (mode 'file', page-scoped) + unlinked (pageSources: [], site-wide)
  conflicts:       {
    pages: PageConflict[]
    rules: RuleConflict[]
    tokens: TokenConflict[]
    crossSheetClasses: CrossSheetClassConflict[]
    files: FileConflict[]   // scripts + kept stylesheets already in site.files
    media: MediaConflict[]  // always [] from buildImportPlan; filled by detectMediaConflicts
  }
  warnings:        ImportWarning[]
  droppedAtRules:  string[]     // source text of un-modelable @-rules
}
```

All URL-shaped values inside `pages[].nodeFragment` props, `pages[].seo` file URLs (favicon, Open Graph / Twitter image, link hrefs), imported `htmlAttributes` bags, style rule `styles`/`contextStyles`, and supported raw style-rule blocks such as `@keyframes` are normalised to FileMap keys before the plan is returned — `applyAssetRewrites` does exact-string replacement after upload.

Every `styleRules[]` entry carries `origin: { source, ordinal }` — the stylesheet it came from and its position in it — which the committed `StyleRule` keeps. That is what a re-import reconciles against (see "Re-importing a site" below). `styleRuleSources` stays alongside as the wizard's index-aligned display grouping: a rule the cross-sheet resolver materialises has a display group but no origin.

`PagePlan.imageAlts` maps each `base.image` node id to the authored `<img alt>` (an empty string is a deliberate decorative alt). `buildAssetPlan` copies it onto the planned `ImportAsset.altText` — first page to describe a file wins — and the upload creates the Media Library record with it. Alt is never a per-instance prop.

`ImportScript` entries carry optional npm dependency requests when module-script CDN imports were converted:

```ts
interface ImportScript {
  path: string
  content: string
  format: 'classic' | 'module'
  placement: 'head' | 'body-end'
  pageSources: string[]
  priority: number
  dependencies?: { name: string; version: string }[]
}
```

`priority` is one number per script, so it is derived from every page's document order at once (`scriptOrder.ts`): each page contributes "a before b" edges between neighbouring scripts, the merged order is a topological sort with first-seen order as the tie-break, and a script shared by two pages therefore sorts after whatever either page loads before it. Pages that genuinely contradict each other keep the first page's order and emit a `script-order-conflict` warning.

Inline classic scripts in `<head>` run immediately, including those with `async` or `defer`. External classic head scripts also block parsing when neither attribute is present. Both import with `placement: 'head'` and `timing: 'immediate'` to preserve pre-paint behavior. Body scripts, modules, and deferred or asynchronous external scripts use the publisher's `'body-end'` placement. A script shared by several pages uses `'head'` only when all of those pages run it there.

---

## What each category imports

| Category | What | How |
|---|---|---|
| **Pages** | One `PagePlan` per `.html` file | `makeHtmlPagePlan` parses the body via `@core/htmlImport`; slug derived from the relative file path (`documentation/index.html` → `documentation`, `guides/install.html` → `guides/install`) |
| **Page head** | Everything in `<head>` besides `<title>`, stylesheets and scripts, plus JSON-LD anywhere in the document | `extractHeadSeo` (`headSeo.ts`) reads it into `PagePlan.seo` (the page's `PageSeo`, see [publisher.md](publisher.md) → "Page head settings"): description, canonical, robots, theme-color (each with its `media`), color-scheme, the first plain `rel="icon"` as the favicon, `og:*` and `twitter:*` into their structured fields (other `og:*` / named meta as extra `meta`), allowlisted `<link>` rels as `links`, `application/ld+json` blocks as `jsonLd`. `buildAssetPlan` resolves the favicon, Open Graph / Twitter images and link hrefs like node props: an uploadable file is uploaded and rewritten to its media URL, a file the media library cannot store keeps a root-relative link with `head-file-not-hosted`, external URLs and origins pass through. Committed by `tx.addPage` / `tx.overwritePage` (an overwrite replaces the page's settings). Anything else is reported as `head-tag-dropped`. |
| **HTML attributes** | Safe extra attributes on ordinary elements (`id`, ARIA, `role`, custom attrs, `data-*`, etc.) | Stored as `props.htmlAttributes` on base container/text/link/button/image modules, `base.form` and every form control (`base.label`, `base.input`, `base.textarea`, `base.select`, `base.option`, `base.option-group`, `base.checkbox`, `base.radio`, `base.submit`; so `inputmode`, `step`, `aria-describedby` and `data-*` hooks survive) so CSS selectors, anchors, classic scripts, accessibility attributes, and template runtime hooks such as `data-bg-src`, `data-aos`, and `data-bs-*` survive import. Users edit the same bag in the Properties panel's Attributes view. `class` is handled by the selector registry, inline `style` becomes `node.inlineStyles`, event handlers are stripped, and reserved Instatic/editor `data-*` names are not imported. Local asset URLs inside these attributes are uploaded and rewritten. |
| **Style rules** | All rules from linked CSS files and their unconditional local `@import` graph | `expandLinkedCssImports` follows bundled local CSS imports first, then `cssToStyleRules` maps selector declaration blocks to `NewStyleRule` entries (class or ambient kind) and stores supported stylesheet-level rules such as `@keyframes` as ambient raw CSS rules |
| **Media** | Uploadable images (JPEG, PNG, GIF, WebP, AVIF, SVG), videos, and fonts — including unreferenced files in the bundle | `buildAssetPlan` collects referenced assets and sweeps uploadable unreferenced files. Source companions such as `.scss`, sourcemaps, PHP mailers, `desktop.ini`, and README files are excluded before upload. An `<img>`'s authored `alt` is carried onto the asset and stored on the Media Library record at upload; `loading`, `decoding`, and `fetchpriority` map onto the Image module's first-class props when they hold a value the module offers (anything else keeps the module default). Uploaded assets are filed under folders mirroring their bundle path; a folder failure leaves the asset at the media root with an `asset-folder-failed` warning and never blocks the URL rewrite. |
| **Color tokens** | CSS custom properties on `:root` / `html` / `body` that look like colours | `extractRootColorTokens` pulls them into `ImportColorToken[]`; they become framework palette tokens. The framework parses hex, rgb/rgba, and hsl/hsla into channels (deriving shades/tints/transparent steps); any other authored value (oklch(), color-mix(), …) still emits its base `--<slug>` verbatim so `var(--x)` references never break. The slug is the framework's normalised form (`--brand---neutral--700` → `--brand-neutral-700`), settled at plan time by `normalizeImportedTokens` (`tokenNames.ts`); every imported `var()` reference and declaration of a renamed name is rewritten to it, and two names that normalise to the same slug both survive (the one already in normalised form keeps it, the other takes a `-2` suffix). A `--<slug>` that collides with an existing colour token surfaces as a `TokenConflict` (rename / skip / overwrite) |
| **Fonts** | Self-hosted `@font-face` families with at least one bundled file, plus trusted Google CSS2 imports | `buildFontFamilies` in `assetPlan.ts` picks the best bundled format (woff2 → woff → ttf → otf); `extractGoogleFontImports` turns Google CSS2 `@import` rules into install requests. Commit uploads custom files via `tx.addFonts`, installs Google families through the CMS Google-font installer, then merges those returned `FontEntry` records via `tx.addInstalledFonts` |
| **Font tokens** | Root `--font-*` variables with font-family stacks | `extractRootFontTokens` pulls them into `ImportFontToken[]`. The variable is the store's normalised form (`--font-Heading` → `--font-heading`), settled at plan time by `normalizeImportedTokens` together with the colour slugs (both kinds share one CSS namespace, so neither takes the other's name): references and declarations of a renamed name are rewritten, and two names that normalise to the same variable both survive. Committed via `tx.addFontTokens` after fonts so matching imported families can be assigned. A `--font-*` that collides with an existing font token surfaces as a `TokenConflict` (rename / skip / overwrite) |
| **Scripts** | Executable inline scripts and JS files linked by imported HTML | Ordered so every page's document order holds at once (see `priority` above), kept in `<head>` when the page ran them there before first paint (see `placement` above), and committed via `tx.addScripts` with page scope from the source HTML. Classic scripts remain plain `<script>` assets and bypass bundling; `type="module"` scripts keep module semantics. Module imports from known npm CDNs (`esm.sh`, `esm.run`, `unpkg`, jsDelivr npm URLs) are rewritten to bare package specifiers and recorded as runtime dependencies, so `https://esm.sh/@motion.page/sdk@1.2.4` becomes `@motion.page/sdk` plus `@motion.page/sdk: 1.2.4` in `packageJson.dependencies`. Non-executable script data such as `application/json`, import maps, and templates is skipped. |
| **SVG sprite icons** | `<svg><use href="icons.svg#id">` and same-page `<use href="#id">` | `importHtml` is handed a loader over the FileMap and copies each referenced `<symbol>` (or element) inline before the walk (`@core/htmlImport` → `svgSprites.ts`; see [html-import.md](html-import.md) → "SVG sprite icons"). The sprite file itself is not uploaded: nothing references it after the copy. A reference to a missing file or id, a cyclic one, or one past the copy budget emits `missing-svg-sprite` and that icon stays empty. |
| **Stylesheets (kept)** | Top-level linked sheets the user opted into `mode: 'file'` | Flattened `@import` graph, Google imports stripped, `url()` normalised; committed via `tx.addStylesheets` as a `SiteFile` (`type: 'style'`) + `site.runtime.styles` entry scoped to the linking pages. Editable afterwards in the Site panel's Styles section and the code editor. |
| **Stylesheets (unlinked)** | CSS files no imported page links | Same flattening and commit path as a kept sheet, but with no `pageSources`: the `site.runtime.styles` entry takes the default all-pages scope, so the file applies to every page and shows in the Code panel. |

---

## CSS rule mapping

`cssToStyleRules` parses a CSS file using the browser's native `CSSStyleSheet.replaceSync()`.

| Source rule | Stored as |
|---|---|
| `.foo { … }` | `StyleRule{ kind:'class', name:'foo', selector:'.foo' }` |
| `.hero .title`, `.group:hover .group-hover\:block` | One bindable class rule per selector-list alternative. The rightmost decoded class is `name`; the full selector is preserved. Selector dependency classes (`hero`, `group`) receive bare picker entries when they have no rule of their own. |
| `h1`, `body`, `a:hover` | `StyleRule{ kind:'ambient', selector: verbatim }` |
| `@media ... { … }` | Merged into a matching viewport context's `contextStyles` when it matches a configured media query (or an older/default max-width threshold); otherwise preserved as a reusable media condition |
| Unconditional local `@import "file.css"` | Followed recursively from the linked stylesheet; the imported file keeps its own source path so relative `url(...)` assets resolve correctly |
| Trusted Google CSS2 `@import` | Parsed into `ImportGoogleFont` install requests and committed as self-hosted installed font entries |
| `@keyframes` | Stored as a supported ambient raw CSS rule and emitted globally by the publisher after its raw-keyframes safety gate |
| Conditional local `@import`, arbitrary external `@import`, `@layer` | Dropped; source text added to `droppedAtRules`; a `dropped-at-rule` warning emitted when surfaced by the CSS engine |
| `@font-face` | Captured as `ParsedFontFace`; resolved into `ImportFontFamily` by `buildAssetPlan` |

---

## Per-stylesheet import modes

Every top-level linked stylesheet imports in one of two user-selectable modes (`StylesheetImportMode`, picked in the Review step's Style rules pane, default `'convert'`):

- **`'convert'`** — the sheet is parsed into editable style rules: class rules become registry classes, ambient rules, `@keyframes`, colour/font token extraction. Converted sheets merge into the site's ONE global cascade, CSS-natively — exactly like a browser loading them all.
- **`'file'`** — the sheet's CSS imports verbatim as a `SiteFile` (`type: 'style'`) plus a `site.runtime.styles` entry scoped to **exactly the pages that linked it**. No selector rewriting, no generated classes — page isolation comes from the runtime scope, and the file is immediately editable in the Site panel / code editor and rendered in the canvas via the user-stylesheet pipeline. Kept sheets skip ALL semantic extraction (no rules, no tokens — the file is the single source of truth); only two things still touch them: `url(...)` payloads normalise to FileMap keys so referenced media/fonts upload and rewrite (`buildAssetPlan.normalizeRawCssUrls`), and trusted Google CSS2 `@import`s are stripped + installed as self-hosted fonts. The sheet's unconditional local `@import` graph is flattened into the file in cascade order (each part keeps a `/* source path */` header). Nodes keep their class-name tokens; commit auto-creates bare style-less registry classes for them (the standard `linkImportedClassNames` step), so pills and pickers work and panel overrides can layer on top.

## Stylesheets no page links

A CSS file that no imported page links (a lone `.css` drop, or CSS in a bundle whose pages never reference it) has no page cascade to convert into. `collectUnlinkedStylesheets` (`stylesheetPlan.ts`) plans each one as an `ImportStylesheet` with `pageSources: []`:

- It is flattened exactly like a kept sheet (local `@import` graph inlined, Google imports stripped and installed, `url()` assets uploaded and rewritten) and takes the cascade priorities after the kept sheets.
- A file another unlinked file `@import`s is part of that file, not a sheet of its own. An `@import` cycle among unlinked files still yields one sheet (roots are taken in FileMap order). A file a linked sheet `@import`s is part of that sheet's cascade and never counts as unlinked.
- At commit, `resolvePageScopes` passes a sheet with no `pageSources` through without `pageIds`, and `addImportedStylesheets` registers it with `DEFAULT_STYLE_RUNTIME_CONFIG.scope` (`all-pages`).
- `filterPlanBySelection` keeps an included site-wide sheet whatever pages are selected; a page-scoped kept sheet still drops when none of its pages import.

Selection default (`makeDefaultSelection`): with **no pages** in the import the unlinked sheets are included, because the stylesheet is what the owner came to import. With **pages** in the import they are offered switched off: those pages never loaded the file (a template's unminified copy, an RTL sheet, an alternate skin), so applying it to every page would change how the imported pages look. One switch in the Style rules pane includes it.

What a switched-off sheet asks for follows it out. Each planned Google font records where it was requested (`ImportGoogleFont.requestedByConvertedCss` and `stylesheetPaths`, filled by the shared collector in `buildImportPlan`). `isGoogleFontRequested` (`importPlanning.ts`) is the one rule: converted CSS always requests its fonts, and a family only stylesheet files `@import` is wanted only while one of those sheets imports. `filterPlanBySelection`, the Continue count, and the Fonts pane all go through it, so an RTL sheet's font is neither installed nor shown on while the sheet is off, and comes back on with the sheet. `url()` files the sheet references are not affected: every uploadable file in the drop already imports through the media sweep, so they stay under Media like any other bundled file.

## Cross-sheet class conflicts (converted sheets)

A multi-page site typically links one stylesheet per page, often on top of a shared kit, and those stylesheets routinely style the same class name (`.btn`, `.hero`) differently. The CMS has a single global style rule registry, so a naïve merge would let one page's rules reach every other page. The bar is that every imported page renders as its source did: no rule is dropped and no page picks up rules it never loaded, unless the user chooses so in a visible row.

`detectCrossSheetClassConflicts` (`classCascades.ts`) works per class name over each page's ordered linked CSS cascade (inline `<style>` blocks are a synthetic `<page>::inline` sheet at the end of it):

- **`leak` rows.** When every page loads the sheets defining the class in the plan's emit order (`definingSheetsInPlanOrder`), each defining sheet is checked on its own: if some imported page uses the class (a node carries it, or a script that page loads writes it, see below) without loading that sheet, the sheet is one `leak` row ("would also style pages that do not load it"). A sheet every user of the class loads raises nothing, since keeping it global changes no page. This covers a kit restyled by a page sheet, two page sheets restyling one kit class, and a class only one page's sheet styles that another page uses unstyled.
- **`divergent` rows.** When pages load the defining sheets in orders no single global order satisfies (an override loaded before the kit on one page and after it on another, or two sheets swapped), the first definition keeps the bare name and each later distinct definition is one `divergent` row, as before.
- **Bootstrap-like shared utility names** (`row`, `col-xl-3`, `d-flex`, `align-items-stretch`, spacing/gutter utilities, etc.) never conflict. Those classes are framework vocabulary rather than component classes: their behaviour is often assembled from multiple rules and selectors such as `.row`, `.row > *`, and `.col-*`. Splitting them would break the grid contract.

When renaming, the wizard allocates the next suffix, free among existing site names and tokens in imported markup, scripts and selectors, including escaped CSS identifiers. A `leak` row whose sheet an earlier import already confined reuses the name that import gave it (an existing class rule with the same `origin.source` named `<name>-<n>` that the incoming files do not author), so re-importing a bundle reconciles those rules in place through `putStyleRule` instead of stacking a new copy. `detectConflicts` reserves every cross-sheet rename target (`crossSheetRenameTargets`) before it picks site-vs-import class names, so the two kinds of rows never default to the same name, and the Conflicts step validates custom names against both (`classRenameProblems` in `importPlanning.ts`: a valid class name, no other row's target, not an existing site class, not a class the import brings itself; Import stays disabled with the reason in the footer until fixed). Resolutions apply in `applyCrossSheetClassResolutions` (`classCascadeResolution.ts`, via `applyConflictResolutions`, before site-vs-import rule conflicts):

- **leak, rename (default)** — lossless confinement. The class token moves to the new name in every selector of the sheet, including case-sensitive class-word selectors such as `[class~="btn"]`, whatever the rule's own class (`.side .icon`, `.x:not(.btn)`, `.btn .row`; contexts and `@media` blocks stay), and every element on the pages that load the sheet carries the new name NEXT TO the bare one, including the elements inside stored inline SVG markup (`base.svg` `props.svg`). The bare class keeps the other sheets' rules, so a kit's own selectors (`.btn .icon`) still match, and one global stylesheet in plan order applies exactly each page's own fragments in its own cascade order. No generated scope class is involved: the new name is an ordinary registry class the user can see and rename.
- **leak, overwrite** — keep the sheet's rules on the bare name; they apply on every page. This is the default only when a script on the sheet's own pages may put the class on elements at runtime: those elements would never carry the new name, so a rename could break the sheet's own pages. The row still shows the leak.
- **leak, skip** — drop every rule of the sheet whose selector names the class (`.btn`, `.btn:hover`, `.card .btn`), not only its class rules.
- **divergent, rename** — the divergent definition is materialised as ONE class rule under the new name carrying the cascade-merged declarations; the affected cascades' exclusive class fragments for the old name are dropped, class tokens in their exclusive ambient selectors follow the rename, and the affected pages' node class tokens move to the new name. Selectors in shared sheets that name the class do not follow, a known limit of this fallback.
- **divergent, skip** — keep the first definition: the divergent cascades' exclusive fragments are dropped and their pages bind to the kept definition by name.
- **divergent, overwrite** — this definition wins the bare name: every OTHER cascade's exclusive fragments for it are dropped.

A script counts as using a class when one of its string or template literals holds the name as a whitespace-separated token (`addClass('is-open')`, `{ className: "btn btn--lg" }`, a lookup table, a variable), or HTML it builds carries it in `class="…"` (`scriptClassNames` in `classUsage.ts`). This reads conservatively on purpose: over-collecting only makes a row default to keeping the rules global. Selector strings such as `'.btn'` are not bare tokens and do not count. Classes inside stored inline SVG markup count as carried by the page.

After all renames, `normalizeBindableClassRules` enforces the registry's unique-class-name invariant: per final name, the FIRST class-kind rule (in cascade source order) stays bindable; every later same-name class fragment becomes an ambient rule with the same selector — its declarations keep their cascade position, so within-cascade overrides (`base.css .btn` + `page.css .btn`) still compose like real CSS.

All imported class-bearing selectors remain picker-addressable, whether or not
the imported HTML currently uses them. This is what makes a large utility
catalogue (including a full precompiled Tailwind build) useful after import:
escaped names such as `hover:bg-blue-700` are decoded for the class picker while
their original selectors remain intact.

Publishing and the canvas use the same dependency-aware tree-shaker. A
class-kind rule emits only when its registry id is assigned and every known
class dependency in its selector is in use; repeated fragments demoted to
ambient rules emit only when their known selector dependencies are in use.
Class-free ambient selectors and supported raw blocks such as `@keyframes`
remain conservative and global. This retains framework cascades such as `.row`
plus `.row > *` without shipping thousands of unused utilities.

A class that only exists at runtime — a modifier a script toggles, such as
`.nav--open` — is never assigned to a node, so node class ids alone would
prune it. `collectUsedStyleRuleIds` therefore also keeps every class whose
name appears literally in a `type: 'script'` site file: the script source is
split on every character a class name cannot contain, and a class rule whose
name is among the surviving runs counts as used. This over-collects on purpose
(`add`, `length` and every other identifier in the script also land in the
set) — a false positive costs a few bytes of CSS, a false negative drops a rule
that is correct everywhere until publish.

A class only a module's render output carries — a plugin checkout module
writing `commerce-checkout__total` into its own HTML — is likewise never on a
node. A module declares those classes in `ModuleDefinition.emittedClassNames`
(exact names or a `prefix*`), and `collectUsedStyleRuleIds(site, registry)`
keeps every class rule matching the declarations of the modules placed on the
site's pages and Visual Components. Imported CSS written for that markup then
reaches the published stylesheet.

Only literal script names are seen: a class
built by concatenation at runtime still cannot be inferred and must be assigned
in the editor (including to a hidden structural node) or shipped in a
`mode:'file'` stylesheet, the explicit non-tree-shaken escape hatch.

The escape hatch for "this sheet's resets/styles must not leak into other pages at all" is no longer a generated scope class — it is keeping that sheet as a file (`mode: 'file'`), page-scoped via runtime config.

---

## Conflict resolution

`detectConflicts(currentSite, pagePlans, styleRules, colorTokens, fontTokens, scripts, stylesheets)` produces four lists; `crossSheetClasses` comes from `detectCrossSheetClassConflicts` (see above) and `media` from `detectMediaConflicts` (see "Re-importing a site"):

- **`PageConflict`** — a desired slug collides with an existing page slug or with another slug in the same import batch.
- **`RuleConflict`** — a `kind:'class'` rule's name collides with an existing class name. Ambient rules never conflict. One row per name even when the name arrives as several cascade fragments (they rename together).
- **`TokenConflict`** — a design-token CSS custom property collides with an existing token. One type covers both colour tokens (keyed by `--<slug>`, against `framework.colors.tokens`) and font tokens (keyed by `--font-*`, against `fonts.tokens`), since both are just a `--var` contract referenced by `var(--x)` in the imported CSS. Imported tokens are deduped per kind upstream, so only site-vs-import collisions occur. A rename target also skips the import's other token names and every custom property the imported CSS declares, so a renamed token never lands on a variable that is already in use. Token conflicts default to auto-rename, with one exception: when the existing font token is an untouched seeded role token (`font-heading`, `font-body` or `font-mono` with its seeded name and fallback and no bound family, checked by `isUntouchedFontRoleToken` in `src/core/fonts/roles.ts`), the default is overwrite. The imported family and fallback land on the role token and imported rules keep `var(--font-body)`, so importing into a new site behaves as if the token were absent. A role token the user has edited keeps the rename default.
- **`FileConflict`** — an imported script or kept stylesheet lands at a `site.files` path a file of the same kind already holds (`importedSiteFilePath`, the same mapping the store commit uses). Keyed by `(kind, path)`.
- **`CrossSheetClassConflict`** — a `leak` (a sheet's rules for a class would reach an imported page that does not load it) or a `divergent` definition (see "Cross-sheet class conflicts" above). Keyed by `(desiredName, definitionId)`; resolutions apply FIRST in `applyConflictResolutions` so a renamed definition no longer participates in the site-vs-import conflict on the original name.

A repeated import reuses existing class bindings from the same stylesheet and the bare, unstyled classes left on nodes for scripts. Equal incoming color values and font stacks reuse their existing tokens. A different file colliding with an authored class still proposes a rename. Renaming a binding rewrites ancestors and subjects in compound selectors together, preserving membership attributes such as `[data-has-plan="true"]`.

Distinct conditional overrides on the same selector keep separate ordered rule fragments. Overlapping media queries therefore cascade in source order even when the site's existing viewport and condition registries list them differently.

Page conflicts are detected twice. `buildImportPlan` checks the slugs derived from file paths; when the user continues from Review, `withPageSlugs(filteredPlan, site, typedSlugs)` gives each selected page the route typed in its Route field (normalised by `normalizePageSlug`) and detects page conflicts again, so a page renamed onto an existing route such as `index` lands in the Conflicts step instead of being suffixed to `index-2` by `addPage` at commit. Running it on the selection-filtered plan means a deselected page claims no route. A conflict whose desired slug is unchanged keeps the choice already made for it.

Page slugs can be slash-delimited public paths. Root `index.html` stays the homepage slug `index`; nested `index.html` files use their directory route, so `documentation/index.html` imports as `/documentation` and does not collide with `download-version/index.html`.

Each conflict has a `defaultResolution`:
- `auto-rename` — append `-2` (or `-3`, `-4`, …) until unique. This is the default.
- `overwrite` — replace the existing page / rule / token value.
- `skip` — do not import this item.
- `custom-rename` — the user typed a new slug / class / token variable.

`applyConflictResolutions(plan, pageResolutions, ruleResolutions, tokenResolutions)` applies the resolutions to the plan:
- Page renames update the slug; rule renames update the `name` + `selector` and remap `classIds` on nodes.
- **Token renames** rename the imported token in `plan.colors` / `plan.fontTokens` AND rewrite every `var(--old)` → `var(--new)` reference across the imported style rules (`styles` + `contextStyles`) and node `inlineStyles`, so the imported design keeps resolving to its own token instead of silently binding to the pre-existing same-named one (fallbacks like `var(--x, serif)` are preserved).
- **Token skip** drops the imported token (references keep the old name and bind to the existing token).
- **Token overwrite** keeps the imported token in place; `commitImportPlan` replaces the existing token's value by id via `tx.overwriteColorTokens` / `tx.overwriteFontTokens` (the variable name is unchanged, so both sides keep resolving).

`commitImportPlan` applies page/rule skip/overwrite actions from `defaultResolution` at commit time, and partitions tokens into add vs. overwrite (skip and rename were already materialised into the plan by `applyConflictResolutions`).

The conflict wizard renders bulk controls in each of the three renamable conflict categories — pages, class names, and design tokens — each settable to rename with a numeric suffix, skip, or overwrite in one action; the page overwrite bulk action is hidden when any listed page conflict is only an intra-import collision and has no existing page to replace. Individual rows use segmented controls for the same actions and still allow custom renames after a bulk action.

---

## Re-importing a site

Running the wizard twice on the same bundle is a no-op for its ambient rules: each arrives again and replaces itself rather than stacking a second copy (class rules still pass through the Conflicts step, see below). Every rule parsed from a stylesheet carries `origin: { source, ordinal }` (stamped in `buildAssetPlan`, persisted on the committed `StyleRule`). At commit, `tx.putStyleRule` asks the store for the rule with the same origin **and** the same selector (`findReimportedStyleRule`, `importLinking.ts`); when one exists it is overwritten in place — id and cascade `order` kept, declarations replaced — otherwise the rule is added. Both conditions are needed: a stylesheet that gained a rule shifts every later ordinal (those must arrive as new rules, not overwrite unrelated ones), and a selector alone would let a theme's `body {}` replace a user-authored `body {}` or collapse a sheet that legitimately declares one selector twice.

Class rules still pass through `RuleConflict` first (the registry's unique-name invariant), so a re-imported class lands under the user's chosen resolution. Ambient rules never conflict and rely on the origin match alone. The single-fragment paste path (`insertImportedNodes` → `mergeImportedStyleRules`) uses the same `findReimportedStyleRule`; pasted `<style>` CSS has no origin, so there it falls back to skipping an ambient selector that already exists.

Pages are not reconciled this way: a second import of `about.html` is a slug conflict with the usual rename / overwrite / skip choice.

**Scripts and kept stylesheets.** Every script and kept stylesheet an import writes carries an `importRecord` on its `SiteFile`: `sourcePath`, the path in the bundle, `sourceHash`, the hash of the file as the bundle delivered it (taken before asset URLs are rewritten; a script’s format, placement and CDN package versions participate in change detection, `importSourceHash`), and `contentHash`, the hash of the content written. Re-import matches the destination and recorded source path so that two bundle files normalized to the same filename keep separate site files, even if their load order changes. A matched file raises a `FileConflict` whose `state` reads that record:

| `state` | Meaning | Default |
|---|---|---|
| `unchanged` | The bundle has the same file as last time (no record: the site copy equals it) | Use existing (`skip`) |
| `changed` | The bundle changed it and the site copy is untouched since the import | Replace (`overwrite`) |
| `edited` | The site copy was edited in Instatic since the import | Use existing, labelled as edited; Replace still offered |
| `differs` | No record (written before this existed, or by hand) and the content differs | Use existing |

So an edit made in Instatic is never discarded by default, and a kept stylesheet whose `url()`s now hold media URLs still reads as `unchanged`. `commitImportPlan` routes `skip` and `overwrite` through `tx.reuseSiteFiles`: the existing `SiteFile` keeps its id and path, and the importing pages join a page-scoped file's runtime scope (an empty `pageIds`, a site-wide sheet, widens it to every page; any other scope is left alone). `overwrite` passes the imported item as `replacement`: new content, a script's format, placement and timing, and a fresh `importRecord` (not rewritten when content and record are unchanged, so a no-op Replace shows no change in branch review). `auto-rename` ("Keep both") adds a second file under a free `-2` path, which is what every re-import used to do.

**npm packages of a replaced script** (`importedScriptDependencies.ts`). A new script only adds packages package.json does not list. A replaced script moves a listed package to the version it now asks for, except when the request is unpinned (`*`, nothing to take), looser than an exact pin, contradicted by another replaced script, or the package is still imported by another site script. Those keep the listed version; all but the unpinned case add a `dependency-version-kept` warning naming the package. Packages no script uses any more are never removed; the Dependencies panel does that.

**Load order.** An import numbers its own files `100, 101, …`; those numbers rank its files against each other only and are never copied onto the site as they are. After adding and reusing, `tx.orderImportedFiles(kind, importOrder, addedIds)` merges the import's files into the site's current order (read the way the runtime sorts: priority, then path) with `mergeImportOrder` (`importOrder.ts`): files outside the import keep their place; the import's already-present files mark the slots it may use and are filled in the import's order, each new file going into the slot of the next present file after it (or after the last; with none present, after the site's files). `prioritiesForOrder` then keeps every priority the merged order allows, gives new files the next free number, and renumbers the whole kind with gaps of 10 from 100 only when that cannot give strictly increasing priorities. No two files of a kind end up tied, so the order never depends on paths. Scripts and kept stylesheets are ordered separately.

**Media.** Every upload stores `media_assets.content_hash`, the SHA-256 of the bytes the client sent; CMS bundle imports (JSON and archive) store it for the bundle's bytes too, on insert and when they overwrite an existing id, so the hash never outlives the bytes it describes. After building the plan the wizard hashes each planned asset (`hashImportAssets`: WebCrypto in a secure context, `sha256HexBytes` otherwise; cached per byte array across plan rebuilds), asks `POST /admin/api/cms/media/lookup` which hashes the library holds, and records each match as a `MediaConflict` (`detectMediaConflicts`, default `skip`, shown as "Use existing"; the oldest matching asset wins). At commit a reused file is not uploaded: its `rewriteMap` entry is the existing asset's URL, so pages, CSS and fonts point at it, and the progress bar counts it done from the start. "Upload a copy" (`auto-rename`) uploads it again. A failed lookup is not fatal: a warning toast says every file will be uploaded and the import carries on. Files dropped onto Review rebuild the plan while an earlier build may still wait on its lookup, so `finalizePlan` aborts the older build and only the latest plan lands; each drop merges into the file map of the newest build (`latestFileMapRef`), so no dropped file is lost. The client splits lookups over 10,000 hashes into several requests. Assets uploaded before migration 040 have no hash and are never matched; a file whose bytes changed is a new upload.

---

## Atomicity

| Phase | Guarantee |
|---|---|
| Asset uploads (Step A) | Network, not reversible. Per-asset failures are caught, recorded as `asset-upload-failed` warnings, and the import continues. Folder placement after a successful upload is best-effort: it can only add an `asset-folder-failed` warning, never fail the asset. Orphaned uploads are harmless — left in the media library for manual cleanup. |
| Store mutation (Step C) | Single `adapter.commit` call. The admin adapter wraps it in one `mutateAllPagesAndSite` call — one patch-based undo entry. Cmd+Z reverts pages, style rules, stylesheet files, fonts, color tokens, and scripts together in one step. |

---

## The wizard

`SiteImportModal.tsx` drives four user-visible stages — **Drop → Review → Conflicts → Import** — shown in the shared `ImportStepper` rail. Completion lives inside the Import stage (the stepper has no separate "Done" stage). Internally the `run` step renders `ImportStep`, whose `RunProgress.phase` switches it between the running, complete, and failed surfaces.

The modal is mounted once at the authenticated admin shell (`AuthenticatedAdmin.tsx`) behind `useAdminUi().siteImportOpen`. It is not owned by the Site editor route. The Site editor, Data workspace, and Spotlight command all open the same shell-level modal state, so importing works from any admin workspace with the required capability.

**Drop** — full-modal drop zone. Accepts loose files, a folder, a static `.zip`, or a CMS-exported `.zip` bundle. A drop whose FileMap has `plugin.json` at its root (`detectPluginPackage`, checked right after `ingestInput`; a single wrapping folder is already stripped) is a plugin package: the wizard stays on Drop and shows a notice naming the plugin and a **Go to Plugins** button that navigates through the admin router and closes the modal. Nothing is imported or installed from here. The button is disabled, with the reason in the notice, for a user without `plugins.install`. A single ZIP is classified before analysis: an Instatic transfer archive has `.instatic/site-bundle.json` as its first stored entry and routes to the CMS bundle review path; any other ZIP is treated as a static-site import and normalized through `ingestInput` to `FileMap`. JSON `SiteBundle` files are still accepted by the internal parser for tests and direct API work, but the exported user-facing artifact is ZIP. Static import analysis needs a `currentSite`; when the modal opens outside the Site editor, it loads the CMS draft through `cmsAdapter.loadSite('default')` before calling `buildImportPlan`. Size guards: 1 GB aggregate, 10 k files, 5 GB uncompressed (zip-bomb guard).

**CMS bundle review** — shown when the dropped archive validates as an Instatic transfer archive. The wizard reads only the manifest for preview, calls `previewSiteBundle` to render a diff against the local site, then lets the user pick `replace`, `merge-add`, or `merge-overwrite` and include/exclude the shell, rows, media, folders, and redirects. Continue routes through the same Conflicts and Import steps as static import. Commit calls `importSiteBundleArchive` with the original ZIP `File`, so media assets stream through `/admin/api/cms/import/archive` instead of expanding into browser memory.

**Analyze (Review)** — category navigator. Left column: one nav entry per import category with its count and include-toggle, plus "Add more files" (files can be added at any point — re-ingests and rebuilds the plan) and a "Can't import" entry for skipped items. Right pane: detail view per category:
- **Pages** — checkbox + inline slug editor per page.
- **Style rules** — opens first when the import has stylesheet files but no pages. A per-stylesheet mode picker first (each top-level linked sheet: "Editable style rules" vs "Keep as stylesheet"; flipping a mode synchronously rebuilds the plan), then converted rules grouped by source stylesheet with a search bar and per-rule checkboxes. Groups up to 60 rules expanded; remaining are collapsed into "+N more". Kept sheets show as a single row with an include checkbox and their page scope. Stylesheets no page links are listed under "Site stylesheets" with a Switch each; the row says the file is added to the Code panel as a site stylesheet applied to every page, or that it is left out.
- **Media** — tiles grouped by MIME class (Images / SVG / GIF / Video / Other) with a per-group Switch.
- **Color tokens** — read-only swatches; all colors always import.
- **Fonts** — Switch per font family; extracted root font variables are shown in the same category and follow the selected family when they reference one. A Google font only switched-off stylesheets request shows off and disabled, naming those sheets.
- **Scripts** — Switch per JS file.
- **Can't import** — list of `droppedAtRules` with reasons.

Continue is enabled when anything is selected (`selectedImportCount`: pages, rules, stylesheet files, media, or fonts), so a stylesheet-only import is valid. With nothing selected it is disabled and the footer note reads "Nothing is selected to import".

**Conflicts** — shown only when conflicts exist. Static imports resolve page slugs (checked against the routes typed in Review), class names, design tokens, cross-sheet classes, files already in the site ("Use existing" / "Replace" / "Keep both", bulk "Use existing all" / "Replace all") and media already in the library ("Use existing" / "Upload a copy", bulk "Use existing all" / "Upload copies"). CMS bundle imports resolve row slug collisions reported by `/admin/api/cms/import/preview`; the default action renames the incoming row to the server-provided next slug, but users can skip or custom-rename each row before import. Those decisions travel as `selection.rowSlugOverrides` to the archive endpoint while the browser still uploads the original ZIP unchanged.

**Import** (`ImportStep`) — a calm, determinate progress surface (no terminal log). A headline activity (phase verb + N of M), a determinate bar with a travelling shimmer, a one-line current-item ticker, and a per-category breakdown mirroring the Review navigator (pending ring → spinner → mint check, with a tint-washed progress fill). Static imports are driven by real pipeline state: media (asset uploads) is the only incremental phase, so it dominates the bar; the other categories land together at the atomic commit. CMS bundle imports show the same surface with CMS-native categories (site, rows, media, folders, redirects) while the server streams the archive. The commit phase is uncancellable; the upload phase is genuinely cancellable — Cancel (or closing the dialog) aborts the run's `AbortSignal`, which stops queued uploads, aborts the in-flight one, and prevents `adapter.commit` and the draft save. A toast reports how many files had already uploaded; those stay in the Media Library.

On success the same step switches to its **complete** state — a success mark, an "Imported into &lt;site&gt;" summary, and every category shown as done. The media count keeps its **planned** total (`makeStaticRunDoneProgress(plan, result)`): a run that set out to upload 30 files and managed 22 shows `22 / 30` with a warning mark, a "8 of 30 media files failed to upload" line, and a `warning` toast instead of a success one. Whenever the run needs attention (`importNeedsAttention`: a media shortfall, or any rank-0 warning such as `unresolved-asset` / `missing-stylesheet` / `missing-svg-sprite` / `script-order-conflict`) the import log opens by itself so the affected paths are on screen without a click. Footer actions: **View import log** / **Hide import log** (per-category counts + warnings) and **Open site →** (jumps to the first imported page, or opens the Site workspace when the import had no pages). On failure it shows an inline error surface, and the failure is also surfaced via toast.

---

## Warning kinds

| Kind | When emitted |
|---|---|
| `dropped-at-rule` | An unsupported at-rule such as `@layer`, conditional local `@import`, or arbitrary external `@import` was present but cannot be modelled |
| `unmatched-media-query` | Legacy warning kind retained for old import reports; current imports preserve unmatched `@media` blocks as reusable conditions |
| `invalid-rule` | A CSS rule caused `replaceSync` to throw (sheet-level parse error) |
| `blocked-property` | A CSS property name is on the security denylist (`behavior`, `-moz-binding`, …) — declaration dropped |
| `duplicate-class` | Two `.foo {}` rules in the same file; both stay separate rules in source order, so the later one still cascades after anything between them (the repeat becomes an ambient fragment at commit) |
| `missing-stylesheet` | A `<link rel="stylesheet">` href was not found in the FileMap (a cache-busting `?v=…` query is stripped before the lookup, so it is not a cause) |
| `asset-upload-failed` | An individual asset upload was rejected by the server; the original FileMap path remains in the import |
| `asset-folder-failed` | The asset uploaded and its URL was rewritten, but filing it under the folder mirroring its bundle path failed; it sits at the media root |
| `script-order-conflict` | Two pages link the same scripts in contradictory orders; the order from the page that links them first wins |
| `dependency-version-kept` | A replaced script asks for another npm version than package.json lists and the listed one stays (looser than a pin, other site scripts still import it, or two replaced scripts disagree); `path` is the package |
| `missing-svg-sprite` | An inline `<svg><use href>` points at a sprite file or id the import does not contain, references itself, or would exceed the copy budget; that icon stays empty |
| `external-font` | An `@font-face` with no bundled file (all `src` entries are external URLs) — skipped |
| `unresolved-asset` | An HTML/CSS reference to a media file the archive does not contain under that path — one warning per distinct path |
| `head-tag-dropped` | A `<head>` tag the page's SEO settings cannot hold: `http-equiv` (other than `content-type` / `x-ua-compatible`), a script preload or `modulepreload`, an unknown link `rel`, a reserved meta name, JSON-LD that is not JSON, or values past the schema's length / count limits |
| `head-file-not-hosted` | A head link points at a file the media library cannot store (`llms.txt`, a web manifest, a stylesheet), or at a non-media file the archive does not contain; the link is kept, pointing at the file's root-relative path (`/bake/llms.txt`) |

### Cache-busted URLs

Reference resolution strips any query string or fragment before looking a path up in the FileMap. Canonical, Open Graph and alternate page links retain those suffixes on the published URL:
`assets/site.css?v=8f3a1c` and `assets/site.css` address the same file. This applies to
`<link rel="stylesheet">`, `<script src>`, CSS `@import`, CSS `url()`, and node `src` / `href` / `srcset` / `videoUrl` / `poster` —
static site generators commonly emit a content hash on all of them.

The original URL is preserved for the in-place CSS rewrite; only the lookup is affected.

The import log shows the first 12 warnings, ordered so the kinds that name a
missing file come first and the CSS interpretation notes last
(`rankWarning` in `importProgress.ts`).

### Filename matching

Asset references resolve by exact FileMap key first. On a miss, the path is
compared punctuation-insensitively (lowercased, with everything but letters,
digits, `.` and `/` removed) against every file in the archive. This exists
because exporters do not always agree with themselves: a Webflow export stores
`101-&Berlin-Office-Us+ Coworking.webp` and references it from the HTML as
`101-Berlin-Office-Us-Coworking.webp`, so an exact-only match imports the page
with a broken image.

The fallback match must be **unique**. Two files that differ only in
punctuation are two different files, and picking one would put the wrong image
on the page — so ambiguity falls through to the same `unresolved-asset`
warning as genuine absence. Only references whose extension maps to an
uploadable media MIME are reported: anchors to extensionless routes and pages
outside the archive are normal and would bury the real misses.

---

## Forbidden patterns

| Pattern | Use instead |
|---|---|
| Importing from `src/core/siteImport/` deep paths outside the module | Use the barrel: `import { buildImportPlan } from '@core/siteImport'` |
| Adding React, admin, or server imports to any file in `src/core/siteImport/` | Keep the pipeline headless; gated by `siteImport-headless.test.ts` |
| Using `as Foo` at a boundary instead of the TypeBox schema | All boundaries use `readValidatedBody` / TypeBox schemas |
| Silent empty `catch (_err)` in the commit loop | Per-asset failures emit an `asset-upload-failed` warning and continue |
| Calling `commitImportPlan` without running `buildImportPlan` first | The plan's `styleRuleSources`, `conflicts`, and `droppedAtRules` fields are required by the wizard |

---

## Related

- [docs/features/html-import.md](html-import.md) — `@core/htmlImport` is used by `htmlPagePlan.ts` to parse each HTML file's body into a `PageNode` fragment
- [docs/features/site-transfer.md](site-transfer.md) — CMS bundle export/import archive format and server endpoints used by the CMS branch of this modal
- [docs/features/fragments.md](fragments.md) — inserting one section, page or component from another site; shares the cascade-order allocator (`createStyleRuleOrderAllocator`, `@core/page-tree`)
- [docs/reference/page-tree.md](../reference/page-tree.md) — `NodeTree<PageNode>`, `ImportFragment` shape
- [docs/reference/typebox-patterns.md](../reference/typebox-patterns.md) — boundary validation
- Source-of-truth files:
  - `src/core/siteImport/types.ts` — `ImportPlan`, `ImportResult`, `ImportFontToken`, `ImportColorToken`, error classes
  - `src/core/siteImport/warnings.ts` — `ImportWarning` and its kinds
  - `src/core/siteImport/buildPlan.ts` — `buildImportPlan`; `src/core/siteImport/commitPlan.ts` — `commitImportPlan`
  - `src/core/siteImport/adapter.ts` — `SiteImportAdapter`, `SiteImportTransaction` interfaces
  - `src/core/siteImport/colorTokens.ts` — `extractRootColorTokens`
  - `src/core/siteImport/fontTokens.ts` — `extractRootFontTokens`
  - `src/core/siteImport/fontImports.ts` — `extractGoogleFontImports`
  - `src/core/siteImport/cssImports.ts` — `expandLinkedCssImports`
  - `src/core/siteImport/stylesheetPlan.ts` — `partitionLinkedStylesheets`, `collectUnlinkedStylesheets`
  - `src/core/siteImport/pluginPackage.ts` — `detectPluginPackage`
  - `src/core/siteImport/classCascades.ts` — cross-sheet class conflict detection; shared-utility vocabulary
  - `src/core/siteImport/classCascadeResolution.ts` — cross-sheet resolutions; bindable-class normalization
  - `src/core/siteImport/classUsage.ts` — which classes each imported page uses (nodes, SVG markup, scripts)
  - `src/core/siteImport/conflicts.ts` — `detectConflicts`, `applyConflictResolutions`
  - `src/admin/modals/SiteImport/SiteImportModal.tsx` — wizard shell
  - `src/admin/modals/SiteImport/steps/AnalyzeStep.tsx` — category navigator + detail panes
- Gate tests:
  - `src/__tests__/architecture/siteImport-headless.test.ts` — no admin/React/server imports in the pipeline
  - `src/__tests__/siteImport/applyAssetRewrites.test.ts`
  - `src/__tests__/siteImport/conflicts.test.ts`
  - `src/__tests__/siteImport/unlinkedStylesheets.test.ts`
  - `src/__tests__/admin/siteImport/SiteImportModal.test.tsx`
