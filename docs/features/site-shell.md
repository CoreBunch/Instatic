# Site Shell

The site shell — the top-level persisted site config. Everything that's "the site" but **not** a page or a Visual Component lives here: name, viewport contexts (`breakpoints` in the persisted schema), settings (colors, typography, spacing), class registry, files, Site Explorer organization, dependencies, and runtime config.

The shell is stored in a single `site` row. Pages and VCs live separately in `data_rows`. The adapter assembles a full `SiteDocument` (shell + pages + VCs) on load.

---

## TL;DR

- One row in the `site` table. Loaded as `SiteShell`; assembled at the client into `SiteDocument` (= `SiteShell & { pages, visualComponents }`).
- Source-of-truth schema: `src/core/page-tree/siteDocument.ts` → `SiteShellSchema`.
- Sub-schemas:
  - `Breakpoint[]` — viewport contexts: canvas frame widths plus their published media queries
  - `ConditionDef[]` — reusable custom `@media`/`@container`/`@supports` definitions (the condition registry)
  - `SiteSettings` — color tokens, typography, spacing scale, framework tokens
  - `Record<string, StyleRule>` — the style rule registry (user-defined CSS rules)
  - `SiteFile[]` — arbitrary text/CSS/JS files attached to the site
  - `SiteExplorerOrganization` — path-derived folders for pages/styles/scripts plus decorative folders for templates/components
  - `SitePackageJson` — `package.json` for the per-site `bun install` workspace
  - `SiteRuntimeConfig` — dependency lock + scripts
- Pages and VCs are **not** embedded. The architecture gate `no-vc-in-site-shell.test.ts` enforces this.
- Tolerant parse: missing identity fields throw; missing settings / files / styleRules / runtime fall back to defaults.

---

## The shape

`src/core/page-tree/siteDocument.ts`:

```ts
export type SiteShell = {
  id:           string
  name:         string
  breakpoints:  Breakpoint[]
  conditions?:  ConditionDef[]   // reusable custom @media/@container/@supports registry
  settings:     SiteSettings
  styleRules:   Record<string, StyleRule>
  files:        SiteFile[]
  explorer:     SiteExplorerOrganization
  packageJson:  SitePackageJson
  runtime:      SiteRuntimeConfig
  createdAt:    number
  updatedAt:    number
}

export type SiteDocument = SiteShell & {
  pages:             Page[]
  visualComponents:  VisualComponent[]
}
```

`SiteDocument` is the **in-memory** view the editor and publisher work with. The DB persists three things separately:

| Persisted shape    | DB location                                                    |
|--------------------|----------------------------------------------------------------|
| `SiteShell`        | `site` row, `settings_json` column                             |
| `Page[]`           | `data_rows` rows where `table_id = 'pages'`                    |
| `VisualComponent[]`| `data_rows` rows where `table_id = 'components'`               |

The site shell schema **does not** include pages or VCs — gated by `no-vc-in-site-shell.test.ts`.

---

## Sub-shapes

### `Breakpoint`

`src/core/page-tree/breakpoint.ts`:

```ts
type Breakpoint = {
  id:            string     // 'mobile' | 'tablet' | 'desktop' | custom
  label:         string
  width:         number     // canvas frame width in px
  mediaQuery?:   string     // published CSS condition; defaults to `(max-width: ${width}px)`
  icon:          string     // pixel-art-icons name
  previewFrame?: boolean    // false keeps the context selectable without rendering a frame
}
```

The default set (`DEFAULT_BREAKPOINTS`):

| id        | label   | width | mediaQuery |
|-----------|---------|-------|------------|
| `mobile`  | Mobile  | 375   | `(max-width: 375px)` |
| `tablet`  | Tablet  | 768   | `(max-width: 768px)` |
| `desktop` | Desktop | 1440  | `(max-width: 1440px)` |

Viewport contexts power three things:

- The canvas's per-viewport iframes (the user sees their page rendered at each context's `width`).
- The `breakpointOverrides` on each `PageNode` (per-viewport prop overrides).
- The class registry's responsive CSS (`@media ...` queries from each context's `mediaQuery`).

Viewport contexts can be added / removed / reordered through Settings → Viewport contexts. Adding a context can create a new canvas frame when `previewFrame !== false`; frameless contexts remain selectable editing contexts for published CSS.

### `ConditionDef` (custom condition registry)

`src/core/page-tree/condition.ts`:

```ts
type ConditionDef = {
  id:        string      // deterministic from content: 'media:<q>', 'container:<name>:<q>', 'supports:<q>'
  label:     string      // human label in the context switcher (e.g. "Dark", "Card ≥400")
  condition: Condition   // { kind: 'media' | 'container' | 'supports', query, name? }
}
```

`site.conditions` is the reusable registry of custom editing contexts. Each `ConditionDef` defines a named `@media`, `@container`, or `@supports` block. Every `StyleRule.contextStyles` key is either a `breakpoint.id` (viewport override) or a `condition.id` (custom condition override).

Conditions are authored via the `CanvasContextSelector` (the canvas top-right editing-context pill). `+ Add context…` opens an inline dialog with a guided builder: preset chips for common `@media` values, range inputs, and a raw CSS escape hatch with live `CSSStyleSheet`-based validation.

Cascade emission order: base → custom conditions (registry order) → viewport contexts. Removing a condition drops its overrides from every rule.

CRUD actions on `classSlice`: `addCondition`, `updateCondition`, `removeCondition`. Active context is tracked in `canvasSlice` via `activeConditionId`.

### `SiteSettings`

`src/core/page-tree/siteSettings.ts`. Per-site configuration, including the design token system:

```ts
type SiteSettings = {
  faviconUrl?:      string
  language?:        string
  framework?:       FrameworkSettings       // colors, typography, spacing, preferences — absent when disabled
  fonts?:           SiteFontsSettings       // installed font library + editable font tokens
  seo?:             SiteSeoSettings         // site-wide SEO defaults — see docs/features/seo.md
  shortcuts:        Record<string, string>  // keyboard shortcut overrides
}
```

`framework` holds the structured design token system (`src/core/framework/`). When present it carries:
- `colors.tokens` — `FrameworkColorToken[]`, each with a slug (becomes a CSS var like `--primary`), light/dark values, utility generation flags (text/background/border/fill), shade/tint variant counts. Slugs are normalized by `normalizeFrameworkColorSlug` (trim, lowercase, strip leading `--`, replace non-alphanumeric runs with `-`). When two tokens normalize to the same root slug, the second receives a `-2` suffix, the third `-3`, and so on — resolved in generation order via `buildColorSlugMap` so the earlier token keeps the base name.
- `typography` — `FrameworkTypographySettings` with fluid scale groups, each emitting `font-size` vars + optional utility classes.
- `spacing` — `FrameworkSpacingSettings` with fluid spacing scale groups, each emitting spacing vars + optional utility classes.
- `preferences` — root font size (`rootFontSize`, constrained `>= 1` at schema level to guard the `px → rem` divisor), fluid clamp screen-width anchors (`minScreenWidth`, `maxScreenWidth`), `isRem` (emit `rem` vs `px`), and `treeShakeGeneratedFrameworkUtilities` flag.

The Colors / Framework Scale / Typography panels write to these sub-trees. All values are emitted into the published `framework.css` by `buildSiteFrameworkCss(site)` via `buildFrameworkPlan(settings)`, which returns the merged `:root` variable block and the locked utility classes from a single ordered traversal per family. (`generateFrameworkRootCss` / `generateFrameworkUtilityClasses` remain for single-output callers such as the canvas preview and the editor's class reconciler.)

`fonts` is the installed font library and font-token contract (`src/core/fonts/`). `fonts.items` is the installed self-hosted font asset library (Google downloads and custom media-backed font files). `fonts.tokens` is the editable builder-facing contract: each token owns a stable CSS variable such as `font-primary`, an optional assigned `FontEntry` id, and a fallback stack. The publisher emits those as `:root { --font-primary: "Family", sans-serif; }`; editor controls should prefer `font-family: var(--font-primary)` over raw family names when the design should follow future font swaps.

**Variable normalization** (`src/admin/pages/site/store/slices/site/fontActions.ts`): the `variable` field stores a slug without the leading `--`. User input is trimmed, lowercased, and invalid character runs replaced with `-`. Leading `--` is stripped before storage. Duplicate variables within a site are rejected. Examples: `--font Brand` → `font-brand`, `Editorial` → `font-editorial`.

**Rename semantics**: when `updateFontToken` changes the `variable`, `rewriteSiteFontVariableReferences` rewrites exact `var(--old-name)` occurrences across all style rules (base + context bags), every page node's inline styles, and every Visual Component tree's inline styles. Only syntactically complete `var(--name)` references are rewritten — not bare text, comments, or partial matches.

**Delete semantics**: `removeFont` blocks removal of an installed font family when any token still references it via `familyId` — the caller receives `null` and must reassign or delete those tokens first. `deleteFontToken` removes the token entry but leaves existing `var(--name)` declarations as unresolved CSS rather than silently rewriting them to raw family stacks.

Editing the colors / typography / spacing in the Site → Framework / Colors / Typography panels writes back to `settings_json` and republishes the affected pages.

### Style rule registry — `Record<string, StyleRule>`

User-defined CSS rules the editor manages.

```ts
type StyleRule = {
  id:           string
  name:         string             // user-facing rule name (CSS class identifier for class-kind rules)
  kind:         'class' | 'ambient'
  selector:     string             // CSS selector, e.g. '.hero-button' or 'h1 > span'
  order:        number             // cascade order; emitted ascending
  description?: string
  scope?:       { nodeId: string } // optional: a scope-anchored rule (one node only)
  styles:       CSSPropertyBag     // base property map
  contextStyles: Record<string, CSSPropertyBag> // viewport/context overrides
  rawCss?:      string             // supported raw at-rules, currently imported @keyframes
  generated?:   { ... }
}
```

See [docs/reference/css-class-registry.md](../reference/css-class-registry.md) for the full mechanics. Key points:

- A rule compiled to CSS via `classCss.ts` in the publisher.
- A node references class-kind rules via its `classIds: string[]`.
- Ambient rules (`kind: 'ambient'`) attach by CSS selector matching — not via `classIds`.
- `rawCss` is reserved for supported stylesheet-level imports such as `@keyframes`; arbitrary selector CSS stays structured in `styles` / `contextStyles`.
- Scoped rules (`scope.nodeId`) generate uniquely-prefixed CSS so they don't affect other nodes.

### Site files — `SiteFile[]`

Arbitrary files attached to the site: CSS stylesheets, TypeScript scripts, React components, assets, config files, and docs.

```ts
type SiteFile = {
  id:         string          // nanoid-generated; stable (path is mutable on rename)
  path:       string          // POSIX-style path relative to site root, e.g. 'src/styles/main.css'
  type:       SiteFileType    // 'component' | 'script' | 'style' | 'asset' | 'config' | 'doc'
  content?:   string          // text content; absent for 'asset' files
  blob?:      { mimeType: string; base64: string }  // binary payload for 'asset' only
  generated?: boolean         // auto-generated by scaffold; hidden until ejected
  ejected?:   boolean         // user has edited a generated file
  createdAt:  number
  updatedAt:  number
}
```

Schema source of truth: `src/core/files/schemas.ts`.

- `'style'` files are concatenated into the page-scoped `userStyles` bundle via `userStylesheets.ts`, honouring each stylesheet's `SiteRuntimeConfig.styles[id]` (enable / scope / priority).
- `'script'` files are exposed to module render functions through `props._siteScripts`.
- `'component'`, `'config'`, and `'doc'` files are stored but not auto-emitted; modules can read them via `ctx.siteFiles`.
- `'asset'` files store binary content in `blob` (base64-encoded); the file's `content` field is absent.

Generated files (e.g. `package.json`, `vite.config.ts`) are hidden in the Site Explorer until the user ejects them. Files are created and renamed through the Site Explorer panel and edited with the CodeMirror-backed code editor.

### Site Explorer organization — `SiteExplorerOrganization`

Site Explorer organization is split by whether a section owns URL/file paths.

Pages, styles, and scripts are structural sections: folders are derived from page slugs or file paths, and changing a folder or item path rewrites those slugs/paths after a confirmation dialog lists the exact changes. Deleting a structural folder deletes every page or file under that path. Templates and Visual Components stay decorative: folders only organize rows in the editor and do not change template routing or component identity.

```ts
type SiteExplorerSectionId =
  | 'pages'
  | 'templates'
  | 'components'
  | 'styles'
  | 'scripts'

type StructuralSiteExplorerSectionId =
  | 'pages'
  | 'styles'
  | 'scripts'

type DecorativeSiteExplorerSectionId =
  | 'templates'
  | 'components'

type SiteExplorerFolder = {
  id: string
  name: string
  order: number  // root-level ordering among folders and unpinned items
}

type SiteExplorerItemPlacement = {
  id: string
  parentFolderId?: string
  order: number
}

type StructuralExplorerRowOrder = {
  kind: 'folder' | 'item'
  id: string
  parentPath?: string
  order: number
}

type StructuralExplorerSection = {
  expandedFolders: string[]
  emptyFolders: string[]
  rowOrder: StructuralExplorerRowOrder[]
}

type DecorativeExplorerSection = {
  folders: SiteExplorerFolder[]
  items: SiteExplorerItemPlacement[]
}

type SiteExplorerOrganization = {
  pages: StructuralExplorerSection
  styles: StructuralExplorerSection
  scripts: StructuralExplorerSection
  templates: DecorativeExplorerSection
  components: DecorativeExplorerSection
}
```

`src/core/page-tree/siteExplorer.ts` owns the schema and reconciliation helpers. On load and after item lifecycle mutations, the editor reconciles structural folders/rows and decorative placements against the current pages, templates, Visual Components, styles, and scripts:

- structural folder rows are rebuilt from slash-delimited slugs/paths plus persisted empty folders
- stale structural row order and decorative item placements are dropped
- missing decorative items are appended in current item order
- generated non-ejected files stay hidden
- the homepage (`slug: 'index'`) is pinned to the root of the Pages section and rendered first

Structural page folders create parent routes because page slugs are URL paths. Structural style/script folders create file path directories. Decorative template/component folders are intentionally flat editor organization.

### `SitePackageJson` — the per-site `package.json`

```ts
type SitePackageJson = {
  dependencies:    Record<string, string>
  devDependencies: Record<string, string>
}
```

The CMS supports plugins that ship their own npm deps and runtime imports (e.g. `three`). When a site declares a dependency, `bun install` runs against a per-site workspace under `uploads/sites/<siteId>/runtime/`, producing a hashed cache directory the server serves at `/_instatic/runtime/cache/<hash>/...`. The runtime cache layout is owned by `src/core/site-runtime/` and served by `server/publish/runtime/`.

The Site → Dependencies panel edits this `package.json`. Saving triggers a `bun install` and updates the runtime lock.

### `SiteRuntimeConfig`

```ts
type SiteAssetScope =
  | { type: 'all-pages' }
  | { type: 'pages'; pageIds: string[] }
  | { type: 'templates'; templatePageIds: string[] }

type SiteRuntimeConfig = {
  dependencyLock: {
    version:   1
    packages:  Record<string, { resolved: string; integrity?: string }>
    updatedAt: number
  }
  // Per-script targeting + load behaviour, keyed by SiteFile id.
  scripts: Record<string, {
    enabled: boolean
    runInCanvas: boolean
    placement: 'head' | 'body-end'
    timing: 'immediate' | 'dom-ready' | 'idle'
    scope: SiteAssetScope
    priority: number
  }>
  // Per-stylesheet targeting + cascade, keyed by SiteFile id.
  styles: Record<string, {
    enabled: boolean
    scope: SiteAssetScope
    priority: number
  }>
}
```

`dependencyLock` is the resolved snapshot from the last successful `bun install` — the publisher uses it to build the `<script type="importmap">` entries that map bare specifiers (`three`) to `/_instatic/runtime/cache/<hash>/...` URLs.

`scripts` and `styles` share the `SiteAssetScope` shape and the `assetScopeAppliesToPage` helper, so a script and a stylesheet target pages identically. Scripts additionally carry `placement`/`timing`/`runInCanvas` (a `<link>` has no execution model, so stylesheets omit those). Both are edited from the floating code editor's left rail (`ScriptSettingsPane` / `StyleSettingsPane`).

---

## Loading the site

```text
GET /admin/api/cms/site + /admin/api/cms/pages + /admin/api/cms/components  (parallel)
    │
    ▼
Client: CmsAdapter.loadSite()  ← src/core/persistence/cms.ts
    │
    ├─→ validateSite(shellBody.site)                      shell validation
    ├─→ validateVisualComponents(rawVCs)                  VC parse + dedup + cycle check
    └─→ validatePages(shell, rawPages, vcs, {             page validation (fault-tolerant)
            tolerant: true,
            storedVcIds: new Set(rawVCs.map(vc => vc.id))
        })
    │
    ▼
SiteDocument assembled inline  →  reconcileSiteExplorerOrganization
    │
    ▼
Editor store: siteSlice initial state
```

The shell's `parseSiteDocument(raw)` is **tolerant in the right places**:

| Field         | Behavior on invalid input                        |
|---------------|--------------------------------------------------|
| `id`          | Throw (required identity)                        |
| `name`        | Throw                                            |
| `breakpoints` | Throw (default would silently destroy customization) |
| `createdAt`, `updatedAt` | Throw                                  |
| `settings`    | Fall back to `DEFAULT_SITE_SETTINGS`             |
| `conditions`  | Per-entry: drop invalid entries; absent → `[]`   |
| `classes`     | Per-entry: drop entries missing `id` or `name`   |
| `files`       | Per-entry: drop invalid entries                  |
| `explorer`    | Fall back to empty folders / current item order  |
| `packageJson` | Fall back to `{ dependencies: {}, devDependencies: {} }` |
| `runtime`     | Fall back to empty lock + scripts                |

Hard fallbacks let the editor render a partially-corrupt site instead of hard-failing; identity-field throws prevent the editor from rendering against the wrong site.

Pages and VCs follow the same principle: `validateVisualComponents` silently drops malformed VC rows; `validatePages` with `tolerant: true` logs and skips unparseable or tree-incoherent page rows rather than aborting the whole load. The `storedVcIds` option threads the raw VC id set through so refs to "loader-repaired" VCs (deduped or cycle-dropped) are not stripped from pages — only refs to VCs genuinely absent from storage are removed. The write path (`validatePages` without options, `tolerant: false`) remains fail-closed.

---

## Saving the site

The shell is saved independently of pages / VCs. Three save paths:

| Endpoint                                    | Saves                                          |
|---------------------------------------------|------------------------------------------------|
| `PUT /admin/api/cms/site`                   | The shell — settings, breakpoints, classes, files (always written) |
| `PUT /admin/api/cms/pages`                  | `{ changedPages, pageIds, baselinePageIds? }` — only changed pages; full id roster drives reaping |
| `PUT /admin/api/cms/components`             | `{ changedComponents, componentIds }` — only changed VCs; cross-VC rules run on the merged roster |

Saves are **incremental**: the editor store derives which pages/VCs changed
from the same Mutative patches that power undo
(`src/admin/pages/site/store/slices/site/dirtyTracking.ts`), and
`usePersistence.ts` ships only those — a one-prop edit uploads one page, not
the site. The full id rosters always go along, so the server's
delete-what's-missing reconcile keeps full-replace semantics (including the
ISS-041 baseline). Anything the tracker can't attribute marks `all` and falls
back to a full save. Granular write gates (`SITE_WRITE_CAPABILITIES`)
enforce what each role can actually change inside the diff.

The page and component roster endpoints are fail-closed: because each reconcile soft-deletes stored rows missing from the incoming roster, malformed entries reject the whole save instead of being repaired by dropping entries. Page and VC trees must have a valid root, matching node-map keys, resolvable child IDs, and no reachable child cycles. Component saves also reject duplicate IDs/names, missing VC refs, and dependency cycles. Tolerant repair remains limited to reads of persisted data where dropping bad entries cannot be misread as an intentional delete request.

All three roster endpoints (`/pages`, `/components`, `/layouts`) write through one shared transaction, `reconcileDataRowRoster` (`server/repositories/data/rows/reconcile.ts`), whose ordering lets a single batch move a slug between rows: soft-deletes run **first** (a changed page may take the slug of a page deleted in the same save — the homepage swap), and slug-changing writes are **two-phase** (park on the placeholder slug `''`, which `data_rows_table_slug_active_idx` exempts, then take the final slug once every old slug is free) so within-batch swaps and rotations never transiently collide with the unique index. Slug-uniqueness validation for pages likewise ignores rows the same request reaps. A write whose id matches a **soft-deleted** row revives that row instead of inserting (undo of a delete re-submits the original id, which still owns the primary key). VC and layout name uniqueness is judged on the **derived slug** (`vcSlugFromName` / `layoutSlugFromName`) — names are stored as `data_rows.slug`, so "Button" and "button" are one identity and reject with a 400 instead of dying on the index.

### Atomic diff validation

The shell save handler validates the diff before applying — e.g. a user with only `site.content.edit` can't change a class definition (style-edit) or rename a breakpoint (structure-edit). The diff validator is in `src/core/persistence/validate.ts` → `validateSite`.

---

## In-memory ↔ persisted

The editor's store works with the in-memory `SiteDocument`:

```ts
{
  ...siteShell,             // id, name, breakpoints, settings, classes, files, runtime, packageJson
  pages:             Page[],
  visualComponents:  VisualComponent[],
}
```

When the editor saves, the persistence layer **splits** the in-memory document back into:

- A `SiteShell` (everything except `pages` and `visualComponents`) → `PUT /site`
- A `Page[]` → `PUT /pages`
- A `VisualComponent[]` → `PUT /components`

The split prevents an "all-or-nothing" save: editing the page roster doesn't risk overwriting a concurrent settings change.

---

## Cookbook

### Read site settings from a panel

```ts
import { useEditorStore } from '@site/store/store'

const settings = useEditorStore((s) => s.site.settings)
const colorTokens   = settings.framework?.colors.tokens ?? []
const fontTokens    = settings.fonts?.tokens ?? []
```

### Add a new viewport context

The editor's Viewport contexts panel calls a `siteSlice` action:

```ts
addBreakpoint({
  label: 'Wide',
  width: 1440,
  mediaQuery: '(min-width: 1440px)',
  icon: 'monitor',
  previewFrame: true,
})
```

The panel rail's per-viewport canvas iframe shows up automatically when `previewFrame` is enabled. Existing nodes can target the new context via `setBreakpointOverride(nodeId, breakpointId, propKey, value)`.

### Add a color token

The Site → Colors panel calls `createFrameworkColorToken(input)` on the editor store's `siteSlice`. The action writes to `settings.framework.colors.tokens`, then calls `reconcileFrameworkClasses` to sync generated utility classes. Saving updates `framework.css` via `buildSiteFrameworkCss(site)` and republishes affected pages.

### Add a site file

The Site Explorer calls `createFile(path, type, content)` from `filesSlice`. For example, adding a stylesheet:

```ts
createFile('src/styles/analytics.css', 'style', '/* ... */')
```

`'style'` files are auto-concatenated into the published bundle. Other types are stored and accessible via `ctx.siteFiles` at render time. `'asset'` files use `updateFileBlob(id, { mimeType, base64 })` instead.

### Declare a site dependency

Site → Dependencies panel edits `packageJson.dependencies`:

```jsonc
{
  "dependencies": { "three": "^0.171.0" }
}
```

Save → server runs `bun install` in the per-site workspace → `runtime.dependencyLock` updates → the publisher emits a `<script type="importmap">` mapping `three` to `/_instatic/runtime/cache/<hash>/three/build/three.module.js`.

A plugin canvas module can then `import * as THREE from 'three'` and it resolves at runtime.

---

## Forbidden patterns

| Pattern                                                              | Use instead                                                 |
|----------------------------------------------------------------------|-------------------------------------------------------------|
| Adding `pages: ...` or `visualComponents: ...` to `SiteShellSchema`  | They're stored separately. Gated by `no-vc-in-site-shell.test.ts`. |
| Reading `site.settings.colorTokens.primary as string` without fallback | `parseSiteSettings` already applies defaults; the type is `string`. Don't add `as string`. |
| Persisting the in-memory `SiteDocument` directly as JSON              | Split into shell / pages / VCs before save                  |
| Hard-failing the entire editor on a corrupt `settings_json`           | The parser falls back; the editor renders with defaults     |
| Hardcoding the breakpoint list                                       | Read from `site.breakpoints` — users can add custom ones    |
| Writing CSS for a user class manually                                | Add a `StyleRule` to the registry; the publisher compiles it |
| Editing `runtime.dependencyLock` by hand                             | It's the output of `bun install` — let the install handler write it |

---

## Related

- [docs/architecture.md](../architecture.md) — system overview
- [docs/editor.md](../editor.md) — editor store consumes `SiteDocument`
- [docs/features/publisher.md](publisher.md) — framework CSS + class CSS pipelines
- [docs/features/content-storage.md](content-storage.md) — pages and VCs live in `data_rows`
- [docs/reference/css-class-registry.md](../reference/css-class-registry.md) — class registry details
- [docs/reference/design-tokens.md](../reference/design-tokens.md) — editor token catalog
- Source-of-truth files:
  - `src/core/page-tree/siteDocument.ts` — `SiteShellSchema`, `SiteDocument`, `parseSiteDocument`
  - `src/core/page-tree/siteSettings.ts` — `SiteSettingsSchema`, `DEFAULT_SITE_SETTINGS`, `parseSiteSettings`
  - `src/core/page-tree/breakpoint.ts` — `BreakpointSchema`, `DEFAULT_BREAKPOINTS`
  - `src/core/page-tree/condition.ts` — `ConditionDefSchema`, `conditionId`, `conditionLabel`, `makeConditionDef`, `parseConditions`
  - `src/core/page-tree/styleRule.ts` — `StyleRuleSchema`
  - `src/core/framework-schema/schemas.ts` — `FrameworkSettingsSchema`, `FrameworkColorToken`, `FrameworkColorSettings`, `FrameworkPreferencesSettingsSchema`, `GeneratedClassMetadataSchema` (pure leaf — no engine dependency)
  - `src/core/framework/generate.ts` — `buildFrameworkPlan`, `generateFrameworkRootCss`, `generateFrameworkUtilityClasses`
  - `src/core/fonts/schemas.ts` — `SiteFontsSettingsSchema`, `FontEntry`, `FontToken`
  - `src/core/fonts/css.ts` — `generateFontsCss`
  - `src/core/files/schemas.ts` — `SiteFileSchema`, `SiteFileType`, `SiteFileBlobSchema`
  - `src/core/site-dependencies/manifest.ts` — `SitePackageJsonSchema`
  - `src/core/site-runtime/schemas.ts` — `SiteRuntimeConfigSchema`
  - `src/core/persistence/validate.ts` — `validateSite`
  - `server/repositories/site.ts` — `loadDraftSite`, save handlers
  - `server/handlers/cms/site.ts` — `/admin/api/cms/site` endpoint
- Gate tests:
  - `src/__tests__/architecture/no-vc-in-site-shell.test.ts`
