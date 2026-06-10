# Site Import

`src/admin/modals/SiteImport` is the canonical import surface. It routes static-site bundles (HTML pages, CSS files, images, fonts, JS) through `src/core/siteImport`, and routes CMS-exported `SiteBundle` JSON files through the CMS transfer endpoints for full import/export parity.

The static-site pipeline has two parts: a pure analysis function (`buildImportPlan`) that produces an `ImportPlan` preview, and an async commit function (`commitImportPlan`) that uploads assets and writes to the store. CMS bundle imports keep their native semantics: validate the `SiteBundle`, preview against `/admin/api/cms/import/preview`, then apply through `/admin/api/cms/import`.

---

## TL;DR

- Entry: global admin-shell modal, opened from Spotlight or workspace actions. Drop files, a folder, a `.zip`, or a CMS-exported `.json` bundle. Static files use the four-stage modal (Drop → Review → Conflicts → Import, with completion shown inside the Import stage). CMS bundles use Drop → Review bundle → Import.
- `buildImportPlan({ fileMap, currentSite, options })` — pure, synchronous — produces an `ImportPlan` with pages, style rules, kept stylesheet files, media, color tokens, custom fonts, Google font install requests, font tokens, and scripts.
- **Per-stylesheet import modes:** each top-level linked stylesheet either converts to editable style rules (default) or imports verbatim as a page-scoped `SiteFile` stylesheet (`options.stylesheetModes`, picked in the Review step). There are no generated scope classes — page isolation comes from the kept file's runtime scope.
- `commitImportPlan(plan, adapter)` — uploads assets, then wraps all store writes in a single `adapter.commit` call → one Cmd+Z reverts the whole import.
- Static imports load the current CMS draft into the editor store on demand when launched outside `/admin/site`; if no draft exists, the modal creates an empty site before analysis.
- Conflict resolution: rename with a numeric suffix (default), overwrite, skip, or custom-rename — per page slug, per class name, per design token (colour / font CSS variable), and per divergent cross-stylesheet class definition, with category-level bulk actions. Token renames rewrite `var(--x)` references so imports stay faithful.
- What imports: pages, linked CSS plus unconditional local CSS `@import` graphs, `kind:'class'` and `kind:'ambient'` style rules, stylesheets kept as page-scoped files, `@keyframes`, uploadable media/font files, root CSS color tokens, root CSS font tokens, `@font-face` families, known external font stylesheet imports, safe extra HTML attributes on base modules, body-level classes/attributes/style metadata, bare DOM text nodes in mixed content, and executable HTML scripts as page-scoped runtime scripts.
- CMS bundle import preserves exported tables, rows, optional site shell, and embedded media using the same merge strategies as site transfer (`replace`, `merge-add`, `merge-overwrite`).
- HTML forms import through the shared HTML importer as first-class form primitives (`base.form`, controls, labels, submit buttons), not as custom containers.
- What cannot be modeled: `@layer`, conditional local CSS `@import`, and arbitrary external `@import` — surfaced as warnings when the CSS engine exposes them, never silently dropped.
- Headless: `src/core/siteImport/` carries no admin, React, or server imports (gated by `siteImport-headless.test.ts`).

---

## Where the code lives

```text
src/core/siteImport/
├── index.ts             — public barrel
├── types.ts             — all shared types: FileMap, ImportPlan, ImportResult, ImportWarning, error classes
├── ingestInput.ts       — normalize input(s) → FileMap (loose files / folder / .zip)
├── classifyFiles.ts     — extension/MIME → FileRole: html | css | js | image | font | binary | meta
├── htmlPagePlan.ts      — per-HTML-file plan: parse body via importHtml, derive title + slug, resolve <link> refs, and preserve executable scripts
├── cssToStyleRules.ts   — single-file CSS → StyleRule[] / @keyframes raw rules + AssetRef[] + warnings
├── colorTokens.ts       — extract root custom-property color tokens from :root/html/body rules
├── fontTokens.ts        — extract root --font-* custom properties as ImportFontToken[] from :root/html/body rules
├── fontImports.ts       — resolve trusted Google CSS2 @import rules into installed-font requests
├── cssImports.ts        — expand unconditional local CSS @import graphs while preserving each source path
├── classCascades.ts     — cross-sheet class semantics: detect divergent class definitions as explicit conflicts; apply rename / keep-first / overwrite; enforce one bindable class rule per name
├── mimeTypes.ts         — extension → MIME fallback for FileMap entries that carry no MIME type (e.g. ZIP)
├── assetPlan.ts         — normalise URL props/HTML attributes in node fragments + CSS/@keyframes url(); resolve @font-face; collect assets
├── applyAssetRewrites.ts — patch fragment props + CSS/@keyframes url() with new media URLs (post-upload)
├── linkRewrite.ts       — rewrite intra-site <a href> to cms:page:<id> refs
├── conflicts.ts         — detect page-slug + class-name + design-token collisions; apply resolutions (incl. var(--x) rewrites)
├── adapter.ts           — SiteImportAdapter + SiteImportTransaction interfaces
└── applyImport.ts       — top-level orchestrator: buildImportPlan + commitImportPlan

src/admin/modals/SiteImport/
├── index.ts
├── SiteImportModal.tsx          — canonical import wizard shell + CMS bundle router
├── SiteImportModal.module.css
├── steps/
│   ├── DropStep.tsx             — full-modal drop zone (files, folder, .zip)
│   ├── AnalyzeStep.tsx          — category navigator (left) + detail pane (right)
│   ├── CmsBundleReviewStep.tsx  — CMS bundle diff + merge strategy review
│   ├── ConflictsStep.tsx        — page-slug + class-name + design-token conflict resolution rows
│   └── ImportStep.tsx           — determinate progress surface + complete/failed states
└── shared/
    ├── createSiteImportAdapter.ts  — wires adapter to editor store + media API
    ├── useCmsBundleImport.ts       — CMS bundle parse/preview/import flow
    ├── ConflictRow.tsx             — single slug / class-name / token-variable conflict row with resolution picker
    ├── ImportStepper.tsx           — shared four-stage progress rail (Review + Import)
    └── importProgress.ts           — RunProgress model used by ImportStep
```

---

## Data flow

```text
User drops files / folder / .zip / CMS bundle JSON
            │
            ├─ valid SiteBundle JSON → previewSiteBundle → CmsBundleReviewStep
            │                                      │
            │                                      └─ importSiteBundle(strategy)
            │
            ▼
    ingestInput(input)
            │  FileMap: { files: Record<path, {bytes, mimeType}> }
            ▼
    classifyFiles(fileMap)
            │  ClassifiedFile[] — each file has a FileRole
            ▼
    ┌── per HTML file ──────────────────────────────────────────────┐
    │   makeHtmlPagePlan(path, html, fileMap)                       │
    │   → PagePlan { source, title, slug, linkedCssPaths, scripts, │
    │               nodeFragment (via @core/htmlImport) }           │
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
    detectCrossSheetClassConflicts(pagePlans, cssFileResults, existingClassNames)
            │  flags DIVERGENT same-named class definitions across page cascades
            │  as explicit conflicts (default: rename with suffix) — applied later
            │  by applyConflictResolutions, never silently
            ▼
    buildAssetPlan(pagePlans, cssFileResults, fileMap, rawStylesheetSources)
            │  normalizes url() in node props, HTML attributes, CSS values, raw @keyframes
            │  CSS, and kept-stylesheet text to FileMap keys
            │  resolves @font-face → ImportFontFamily[]
            │  flattens kept stylesheets (mode 'file') → ImportStylesheet[]
            │  collects deduplicated asset list
            ▼
    detectConflicts(currentSite, pagePlans, styleRules, colorTokens, fontTokens)
            │
            ▼
    ImportPlan ──► wizard preview (AnalyzeStep → ConflictsStep)
            │
            ▼
    commitImportPlan(plan, adapter)
      Step A: upload assets via adapter.uploadAsset (per-asset try/catch)
      Step B: applyAssetRewrites(plan, rewriteMap) — swap FileMap keys → media URLs
      Step C: adapter.commit(tx) — single atomic store mutation:
                tx.addConditions / tx.addColorTokens / tx.overwriteColorTokens / tx.addScripts
                tx.addFonts / tx.addFontTokens / tx.overwriteFontTokens
                tx.addStyleRule / tx.overwriteStyleRule
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
  assets:          { sourcePath: string; mimeType: string; bytes: Uint8Array }[]
  colors:          ImportColorToken[]
  scripts:         ImportScript[]
  linkedStylesheets: LinkedStylesheet[]   // every top-level linked sheet + its import mode
  stylesheets:     ImportStylesheet[]     // sheets kept as files (mode 'file')
  conflicts:       {
    pages: PageConflict[]
    rules: RuleConflict[]
    tokens: TokenConflict[]
    crossSheetClasses: CrossSheetClassConflict[]
  }
  warnings:        ImportWarning[]
  droppedAtRules:  string[]     // source text of un-modelable @-rules
  unusedCss:       string[]     // CSS files present but not linked by any page
}
```

All URL-shaped values inside `pages[].nodeFragment` props, imported `htmlAttributes` bags, style rule `styles`/`contextStyles`, and supported raw style-rule blocks such as `@keyframes` are normalised to FileMap keys before the plan is returned — `applyAssetRewrites` does exact-string replacement after upload.

---

## What each category imports

| Category | What | How |
|---|---|---|
| **Pages** | One `PagePlan` per `.html` file | `makeHtmlPagePlan` parses the body via `@core/htmlImport`; slug derived from the relative file path (`documentation/index.html` → `documentation`, `guides/install.html` → `guides/install`) |
| **HTML attributes** | Safe extra attributes on ordinary elements (`id`, ARIA, `role`, custom attrs, `data-*`, etc.) | Stored as `props.htmlAttributes` on base container/text/link/button/image modules so CSS selectors, anchors, classic scripts, accessibility attributes, and template runtime hooks such as `data-bg-src`, `data-aos`, and `data-bs-*` survive import. Users edit the same bag in the Properties panel's Attributes view. `class` is handled by the selector registry, inline `style` becomes `node.inlineStyles`, event handlers are stripped, and reserved Instatic/editor `data-*` names are not imported. Local asset URLs inside these attributes are uploaded and rewritten. |
| **Style rules** | All rules from linked CSS files and their unconditional local `@import` graph | `expandLinkedCssImports` follows bundled local CSS imports first, then `cssToStyleRules` maps selector declaration blocks to `NewStyleRule` entries (class or ambient kind) and stores supported stylesheet-level rules such as `@keyframes` as ambient raw CSS rules |
| **Media** | Uploadable images, videos, and fonts — including unreferenced files in the bundle | `buildAssetPlan` collects referenced assets and sweeps uploadable unreferenced files. Source companions such as `.scss`, sourcemaps, PHP mailers, `desktop.ini`, and README files are excluded before upload. |
| **Color tokens** | CSS custom properties on `:root` / `html` / `body` that look like colours | `extractRootColorTokens` pulls them into `ImportColorToken[]`; they become framework palette tokens. The framework parses hex, rgb/rgba, and hsl/hsla into channels (deriving shades/tints/transparent steps); any other authored value (oklch(), color-mix(), …) still emits its base `--<slug>` verbatim so `var(--x)` references never break. A `--<slug>` that collides with an existing colour token surfaces as a `TokenConflict` (rename / skip / overwrite) |
| **Fonts** | Self-hosted `@font-face` families with at least one bundled file, plus trusted Google CSS2 imports | `buildFontFamilies` in `assetPlan.ts` picks the best bundled format (woff2 → woff → ttf → otf); `extractGoogleFontImports` turns Google CSS2 `@import` rules into install requests. Commit uploads custom files via `tx.addFonts`, installs Google families through the CMS Google-font installer, then merges those returned `FontEntry` records via `tx.addInstalledFonts` |
| **Font tokens** | Root `--font-*` variables with font-family stacks | `extractRootFontTokens` pulls them into `ImportFontToken[]`; committed via `tx.addFontTokens` after fonts so matching imported families can be assigned. A `--font-*` that collides with an existing font token surfaces as a `TokenConflict` (rename / skip / overwrite) |
| **Scripts** | Executable inline scripts and JS files linked by imported HTML | Preserved in source order and committed via `tx.addScripts` with page scope from the source HTML. Classic scripts remain plain `<script>` assets and bypass bundling; `type="module"` scripts keep module semantics. Non-executable script data such as `application/json`, import maps, and templates is skipped. |
| **Stylesheets (kept)** | Top-level linked sheets the user opted into `mode: 'file'` | Flattened `@import` graph, Google imports stripped, `url()` normalised; committed via `tx.addStylesheets` as a `SiteFile` (`type: 'style'`) + `site.runtime.styles` entry scoped to the linking pages. Editable afterwards in the Site panel's Styles section and the code editor. |

---

## CSS rule mapping

`cssToStyleRules` parses a CSS file using the browser's native `CSSStyleSheet.replaceSync()`.

| Source rule | Stored as |
|---|---|
| `.foo { … }` (single class) | `StyleRule{ kind:'class', name:'foo', selector:'.foo' }` |
| `h1`, `body`, `a:hover`, `.hero .title` | `StyleRule{ kind:'ambient', selector: verbatim }` |
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

## Cross-sheet class conflicts (converted sheets)

A multi-page site typically links one stylesheet per page, and those stylesheets routinely use the same class name (`.btn`, `.hero`) with different declarations. The CMS has a single global style rule registry, so a naïve merge would let one page's class clobber another's.

`detectCrossSheetClassConflicts` (`classCascades.ts`) compares the effective class definitions produced by each page's ordered linked CSS cascade (fragments merged in source order, not isolated files):

- **One distinct definition** across all cascades → no conflict; the class is shared. Repeated fragments stay in cascade order (see normalization below).
- **N distinct definitions** → the first keeps the bare name; each later distinct definition becomes one `CrossSheetClassConflict` row in the wizard's Conflicts step ("Stylesheets disagree"), default `auto-rename` to the next free suffix (free among imported AND existing site class names). Nothing is renamed silently.
- **Bootstrap-like shared utility names** (`row`, `col-xl-3`, `d-flex`, `align-items-stretch`, spacing/gutter utilities, etc.) never conflict. Those classes are framework vocabulary rather than component classes: their behaviour is often assembled from multiple rules and selectors such as `.row`, `.row > *`, and `.col-*`. Splitting them would break the grid contract.

Resolutions apply in `applyCrossSheetClassResolutions` (via `applyConflictResolutions`, before site-vs-import rule conflicts):

- **rename** — the divergent definition is materialised as ONE class rule under the new name carrying the cascade-merged declarations; the affected cascades' exclusive class fragments for the old name are dropped, class tokens in their exclusive ambient selectors follow the rename, and the affected pages' node class tokens move to the new name. Fragments in stylesheets *shared* with a kept cascade stay put (they also feed the kept definition; their declarations are still present in the materialised rule).
- **skip** — keep the first definition: the divergent cascades' exclusive fragments are dropped and their pages bind to the kept definition by name.
- **overwrite** — this definition wins the bare name: every OTHER cascade's exclusive fragments for it are dropped.

After all renames, `normalizeBindableClassRules` enforces the registry's unique-class-name invariant: per final name, the FIRST class-kind rule (in cascade source order) stays bindable; every later same-name class fragment becomes an ambient rule with the same selector — its declarations keep their cascade position, so within-cascade overrides (`base.css .btn` + `page.css .btn`) still compose like real CSS.

Separately, two groups of single-class rules are converted to `kind:'ambient'` at plan time (`preserveGloballyMatchedClassRules`): classes that no imported node actually uses, and the shared Bootstrap-like utility names above. Static templates often create or toggle unused classes from JavaScript (`.mt-cursor`, `.is-open`, `.show`, etc.); leaving those as editable class rules would let publisher class tree-shaking drop them because no imported node owns their `classIds`. Shared utilities are ambient for a different reason: nodes keep the plain class token, while every source rule for that token remains publishable in cascade order.

The escape hatch for "this sheet's resets/styles must not leak into other pages at all" is no longer a generated scope class — it is keeping that sheet as a file (`mode: 'file'`), page-scoped via runtime config.

---

## Conflict resolution

`detectConflicts(currentSite, pagePlans, styleRules, colorTokens, fontTokens)` produces three lists; a fourth — `crossSheetClasses` — comes from `detectCrossSheetClassConflicts` (see above):

- **`PageConflict`** — a desired slug collides with an existing page slug or with another slug in the same import batch.
- **`RuleConflict`** — a `kind:'class'` rule's name collides with an existing class name. Ambient rules never conflict. One row per name even when the name arrives as several cascade fragments (they rename together).
- **`TokenConflict`** — a design-token CSS custom property collides with an existing token. One type covers both colour tokens (keyed by `--<slug>`, against `framework.colors.tokens`) and font tokens (keyed by `--font-*`, against `fonts.tokens`), since both are just a `--var` contract referenced by `var(--x)` in the imported CSS. Imported tokens are deduped per kind upstream, so only site-vs-import collisions occur.
- **`CrossSheetClassConflict`** — two imported page cascades define the same class differently (see "Cross-sheet class conflicts" above). Keyed by `(desiredName, definitionId)`; resolutions apply FIRST in `applyConflictResolutions` so a renamed definition no longer participates in the site-vs-import conflict on the original name.

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

The conflict wizard renders bulk controls in each of the three conflict categories — pages, class names, and design tokens — each settable to rename with a numeric suffix, skip, or overwrite in one action; the page overwrite bulk action is hidden when any listed page conflict is only an intra-import collision and has no existing page to replace. Individual rows use segmented controls for the same actions and still allow custom renames after a bulk action.

---

## Atomicity

| Phase | Guarantee |
|---|---|
| Asset uploads (Step A) | Network, not reversible. Per-asset failures are caught, recorded as `asset-upload-failed` warnings, and the import continues. Orphaned uploads are harmless — left in the media library for manual cleanup. |
| Store mutation (Step C) | Single `adapter.commit` call. The admin adapter wraps it in one `mutateAllPagesAndSite` call — one patch-based undo entry. Cmd+Z reverts pages, style rules, stylesheet files, fonts, color tokens, and scripts together in one step. |

---

## The wizard

`SiteImportModal.tsx` drives four user-visible stages — **Drop → Review → Conflicts → Import** — shown in the shared `ImportStepper` rail. Completion lives inside the Import stage (the stepper has no separate "Done" stage). Internally the `run` step renders `ImportStep`, whose `RunProgress.phase` switches it between the running, complete, and failed surfaces.

The modal is mounted once at the authenticated admin shell (`AuthenticatedAdmin.tsx`) behind `useAdminUi().siteImportOpen`. It is not owned by the Site editor route. The Site editor, Data workspace, and Spotlight command all open the same shell-level modal state, so importing works from any admin workspace with the required capability.

**Drop** — full-modal drop zone. Accepts loose files, a folder, a `.zip`, or a CMS-exported `.json` bundle. A single JSON file is first checked with `parseSiteBundle`; valid bundles route to the CMS bundle review path. Everything else goes through `ingestInput`, which normalizes static import input shapes to `FileMap`. Static import analysis needs a `currentSite`; when the modal opens outside the Site editor, it loads the CMS draft through `cmsAdapter.loadSite('default')` before calling `buildImportPlan`. Size guards: 1 GB aggregate, 10 k files, 5 GB uncompressed (zip-bomb guard).

**CMS bundle review** — shown when the dropped file validates as `SiteBundle`. The wizard calls `previewSiteBundle` to render a diff against the local site, then lets the user pick `replace`, `merge-add`, or `merge-overwrite`. Commit calls `importSiteBundle`; on success the modal closes and the caller can refresh workspace data.

**Analyze (Review)** — category navigator. Left column: one nav entry per import category with its count and include-toggle, plus "Add more files" (files can be added at any point — re-ingests and rebuilds the plan) and a "Can't import" entry for skipped items. Right pane: detail view per category:
- **Pages** — checkbox + inline slug editor per page.
- **Style rules** — a per-stylesheet mode picker first (each top-level linked sheet: "Editable style rules" vs "Keep as stylesheet"; flipping a mode synchronously rebuilds the plan), then converted rules grouped by source stylesheet with a search bar and per-rule checkboxes. Groups up to 60 rules expanded; remaining are collapsed into "+N more". Kept sheets show as a single row with an include checkbox and their page scope.
- **Media** — tiles grouped by MIME class (Images / SVG / GIF / Video / Other) with a per-group Switch.
- **Color tokens** — read-only swatches; all colors always import.
- **Fonts** — Switch per font family; extracted root font variables are shown in the same category and follow the selected family when they reference one.
- **Scripts** — Switch per JS file.
- **Can't import** — list of `unusedCss` + `droppedAtRules` with reasons.

**Conflicts** — shown only when conflicts exist. Page-slug rows and class-name rows each use a segmented control: `Rename | Skip | Overwrite | Custom`.

**Import** (`ImportStep`) — a calm, determinate progress surface (no terminal log). A headline activity (phase verb + N of M), a determinate bar with a travelling shimmer, a one-line current-item ticker, and a per-category breakdown mirroring the Review navigator (pending ring → spinner → mint check, with a tint-washed progress fill). Everything is driven by real pipeline state: media (asset uploads) is the only incremental phase, so it dominates the bar; the other categories land together at the atomic commit. The commit phase is uncancellable; the upload phase is cancellable (orphaned uploads are harmless).

On success the same step switches to its **complete** state — a success mark, an "Imported into &lt;site&gt;" summary, and every category shown as done. Footer actions: **View import log** (reveals per-category counts + warnings) and **Open site →** (jumps to the first imported page). On failure it shows an inline error surface, and the failure is also surfaced via toast.

---

## Warning kinds

| Kind | When emitted |
|---|---|
| `dropped-at-rule` | An unsupported at-rule such as `@layer`, conditional local `@import`, or arbitrary external `@import` was present but cannot be modelled |
| `unmatched-media-query` | Legacy warning kind retained for old import reports; current imports preserve unmatched `@media` blocks as reusable conditions |
| `invalid-rule` | A CSS rule caused `replaceSync` to throw (sheet-level parse error) |
| `blocked-property` | A CSS property name is on the security denylist (`behavior`, `-moz-binding`, …) — declaration dropped |
| `duplicate-class` | Two `.foo {}` rules in the same file; later declarations win |
| `missing-stylesheet` | A `<link rel="stylesheet">` href was not found in the FileMap |
| `asset-upload-failed` | An individual asset upload was rejected by the server; the original FileMap path remains in the import |
| `external-font` | An `@font-face` with no bundled file (all `src` entries are external URLs) — skipped |

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
- [docs/features/site-transfer.md](site-transfer.md) — CMS bundle export/import format and server endpoints used by the JSON branch of this modal
- [docs/reference/page-tree.md](../reference/page-tree.md) — `NodeTree<PageNode>`, `ImportFragment` shape
- [docs/reference/typebox-patterns.md](../reference/typebox-patterns.md) — boundary validation
- Source-of-truth files:
  - `src/core/siteImport/types.ts` — `ImportPlan`, `ImportResult`, `ImportWarning`, `ImportFontToken`, `ImportColorToken`, error classes
  - `src/core/siteImport/applyImport.ts` — `buildImportPlan`, `commitImportPlan`
  - `src/core/siteImport/adapter.ts` — `SiteImportAdapter`, `SiteImportTransaction` interfaces
  - `src/core/siteImport/colorTokens.ts` — `extractRootColorTokens`
  - `src/core/siteImport/fontTokens.ts` — `extractRootFontTokens`
  - `src/core/siteImport/fontImports.ts` — `extractGoogleFontImports`
  - `src/core/siteImport/cssImports.ts` — `expandLinkedCssImports`
  - `src/core/siteImport/classCascades.ts` — cross-sheet class conflict detection + resolution; bindable-class normalization; shared-utility vocabulary
  - `src/core/siteImport/conflicts.ts` — `detectConflicts`, `applyConflictResolutions`
  - `src/admin/modals/SiteImport/SiteImportModal.tsx` — wizard shell
  - `src/admin/modals/SiteImport/steps/AnalyzeStep.tsx` — category navigator + detail panes
- Gate tests:
  - `src/__tests__/architecture/siteImport-headless.test.ts` — no admin/React/server imports in the pipeline
  - `src/__tests__/siteImport/applyAssetRewrites.test.ts`
  - `src/__tests__/siteImport/conflicts.test.ts`
  - `src/__tests__/admin/siteImport/SiteImportModal.test.tsx`
