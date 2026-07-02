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
  metaTitle?:       string
  metaDescription?: string
  faviconUrl?:      string
  language?:        string
  framework?:       FrameworkSettings       // colors, typography, spacing, preferences — absent when disabled
  fonts?:           SiteFontsSettings       // installed font library + editable font tokens
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

Pages, styles, and scripts are structural sections: folders are derived from page slugs or file paths, and changing a folder or item path rewrites those slugs/paths. The confirmation dialog only appears when there is something to review — actual slug/path rewrites, or a blocker to explain. Renaming, moving, or deleting an *empty* folder rewrites no content paths, so it applies directly (its new/removed path is still persisted in the section's `emptyFolders`/`expandedFolders`/`rowOrder` bookkeeping via the plan commit). Deleting a non-empty structural folder deletes every page or file under that path. Templates and Visual Components stay decorative: folders only organize rows in the editor and do not change template routing or component identity.

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

The whole document saves through ONE endpoint, in ONE server transaction:

```
PUT /admin/api/cms/site-document
{ mode, site,                                    // shell — written only when its content changed
  changedPages,      deletedPageIds,
  changedComponents, deletedComponentIds,
  changedLayouts,    deletedLayoutIds,
  baseSeqs,                                      // rowId → last-synchronized seq (conflict check)
  shellBaseSeq }                                 // the shell's counterpart
```

Two modes:

- **`incremental`** (every editor save): only the changed rows plus
  **explicitly deleted** row ids ship. Rows the save doesn't mention are
  untouched server-side — deletion is stated intent, never inferred from a
  missing roster entry, so a stale client can't delete a sibling session's
  rows by omission (the failure class the retired reap-by-omission protocol
  needed `baselinePageIds` to patch).
- **`replace`** (imports, fresh-site bootstrap): the full collections ship;
  the server derives deletions as stored − shipped. `deleted*Ids` must be
  empty.

Saves are **incremental**: the editor store derives which pages/VCs/layouts
changed — and which were deleted — from the same Mutative patches that power
undo (`src/admin/pages/site/store/slices/site/dirtyTracking.ts`; deletions
come from a pre/post membership diff, robust to any recipe style), and
`usePersistence.ts` ships only those — a one-prop edit uploads one page, not
the site. Delete-then-recreate within one save window nets to a plain write
at snapshot time; the server 400s any id in both the changed and deleted
sets as a backstop. Anything the tracker can't attribute marks `all` and
ships as a replace-mode full save. Granular write gates
(`SITE_WRITE_CAPABILITIES`) enforce what each role can actually change
inside the diff.

`usePersistence` runs saves through a **single-flight queue**: at most one
save on the wire and one queued follow-up that reads the latest store state
— autosave, Cmd+S, save-request events, the MCP bridge, and the unmount
flush can never interleave requests.

The save is **atomic and fail-closed**: shell + components + layouts + pages
commit in one transaction (`server/handlers/cms/siteDocument.ts`), so one
malformed entry rejects the whole save and nothing is persisted — no torn
"shell saved, pages failed" states. Page and VC trees must have a valid
root, matching node-map keys, resolvable child IDs, and no reachable child
cycles. Component saves also reject duplicate IDs/names, missing VC refs,
and dependency cycles — validated against the **merged post-save roster**,
so a page may reference a component created in the same save (the old
components-before-pages request-ordering contract is gone). Tolerant repair
remains limited to reads of persisted data where dropping bad entries
cannot be misread as an intentional delete request.

Row writes go through `applyDataRowChanges`
(`server/repositories/data/rows/apply.ts`), whose ordering lets a single
batch move a slug between rows: explicit soft-deletes run **first** (a
changed page may take the slug of a page deleted in the same save — the
homepage swap), and slug-changing writes are **two-phase** (park on the
placeholder slug `''`, which `data_rows_table_slug_active_idx` exempts,
then take the final slug once every old slug is free) so within-batch swaps
and rotations never transiently collide with the unique index.
Slug-uniqueness validation for pages likewise ignores rows the same request
deletes. A write whose id matches a **soft-deleted** row revives that row
instead of inserting (undo of a delete re-submits the original id, which
still owns the primary key). VC and layout name uniqueness is judged on the
**derived slug** (`vcSlugFromName` / `layoutSlugFromName`) — names are
stored as `data_rows.slug`, so "Button" and "button" are one identity and
reject with a 400 instead of dying on the index.

Every save allocates a **site-global sync sequence number**
(`server/repositories/syncSequence.ts`) inside the transaction and stamps it
on every written or deleted row (`data_rows.seq`) — and on the shell, but
**only when the shell content actually changed** (`shellsEqual` in
`siteDiff.ts` gates the shell write; the shell ships with every save, so an
unconditional stamp would make the shell seq useless as a conflict signal).
The response returns the seq (`{ ok: true, seq }`).

### Conflict detection (multi-admin level A)

Incremental saves carry **base seqs**: for every changed *and* deleted row,
the stored seq the client last synchronized with (`baseSeqs`), plus the
shell's (`shellBaseSeq`). Inside the transaction — *after* `allocateSiteSeq`,
whose counter-row lock serializes concurrent saves on both dialects, making
the check exact — the handler compares each shipped row's STORED seq against
its base:

- stored seq **newer** than the base → another admin changed (or deleted —
  soft-deleted rows are visible to the check via `listDataRowSeqs`) the row
  since this client synchronized;
- **no base entry** for a row that exists in storage → the client doesn't
  know the row at all, so its write would be a blind overwrite;
- the shell is checked only when the incoming shell differs from the stored
  one (one coarse seq for the whole shell — accepted v1 granularity).

Any hit throws `SaveConflictError` (`@core/persistence/saveConflict` — the
same class the client adapter re-throws), rolling the transaction back into
a **409** with `{ error, conflicts: [{ table, rowId, seq }] }`. Nothing is
written. Client-created rows have no stored counterpart and pass by
construction; **replace-mode saves skip the check** (imports replace
deliberately).

Known v1 blind spot: writers OUTSIDE the transactional save (plugin pack
installs via `saveDraftSite`/`saveDataRowDraft`, data-workspace row edits)
do not stamp seqs, so conflict detection cannot see them — those flows
coordinate through `requestCmsSiteReload()` instead. Widening seq stamping
to every writer is live-sync phase B territory.

Client side: `loadSite` seeds `baseSeqs`/`shellBaseSeq` in the editor store
(per-row seqs ride the collection GET responses — `DataRow.seq`; the shell
seq rides `GET /site`). Every successful save bumps the shipped rows' bases
to the response seq — deleted rows **keep** their entries so an undo that
resurrects a saved-deleted row carries the right base. On a 409,
`usePersistence` restores the dirty snapshot, fills `saveConflicts`, and the
**conflict banner** (`SaveConflictBanner`, mounted in `AdminCanvasLayout`)
offers per-target resolution: **Load theirs** fetches the remote state
(single-row `?id=` filter on the collection GETs, or `GET /site` for the
shell) and adopts it via `resolveSaveConflictTheirs` (swaps the row without
undo history, clears its dirty marks, clears the undo history, and for VCs
propagates slot re-sync / ref-cascade removal into consumer pages *with*
dirty marks); **Keep mine** bumps the base seq so the next save overwrites
as a stated decision. Autosave is suppressed while conflicts pend; resolving
the last one flushes the surviving edits through the save queue.

### Atomic diff validation

The save handler validates the shell diff before applying — e.g. a user with only `site.content.edit` can't change a class definition (style-edit) or rename a breakpoint (structure-edit). The shell diff validator is `validateSiteWriteDiff` (`server/handlers/cms/siteDiff.ts`); per-page category diffs run through `validatePageWriteDiff` (`server/handlers/cms/pageDiff.ts`).

---

## In-memory ↔ persisted

The editor's store works with the in-memory `SiteDocument`:

```ts
{
  ...siteShell,             // id, name, breakpoints, settings, classes, files, runtime, packageJson
  pages:             Page[],
  visualComponents:  VisualComponent[],
  layouts:           SavedLayout[],
}
```

When the editor saves, the persistence layer **splits** the in-memory
document into the shell plus per-collection changed/deleted sets — all
inside the one `PUT /site-document` body. Loading stays four parallel GETs
(`/site`, `/pages`, `/components`, `/layouts`) — reads have no atomicity
problem.

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

The Framework panel's Colors tab calls `createFrameworkColorToken(input)` on the editor store's `siteSlice`. The action writes to `settings.framework.colors.tokens`, then calls `reconcileFrameworkClasses` to sync generated utility classes. Saving updates `framework.css` via `buildSiteFrameworkCss(site)` and republishes affected pages.

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
