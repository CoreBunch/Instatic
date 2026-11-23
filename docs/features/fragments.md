# Site Fragments

The portable format for a piece of an Instatic site, and the engine that cuts one out of a site and inserts it into another. The same engine carries **themes**: a site's design variables without its content, applied to another site (see [Themes](#themes)).

A fragment is one versioned file that carries a section (one or more sibling subtrees), a whole page, or a Visual Component, together with everything it needs to render the same in any other Instatic site: the style rules its nodes use and the ambient rules built on them, the conditions those rules key on, the component closure, the design tokens its styles read, the data tables its loops and forms use, its media, and its internal page links. `extractFragment` builds one from a site; `planFragmentInsert` decides what an insert adds to a site (the site's own version of anything always wins); `commitFragmentPlan` carries the plan out with one undo step.

---

## TL;DR

- Code: `src/core/fragments/` (headless, no React/admin/server imports, transitively; gated by `fragments-headless.test.ts`). Barrel: `@core/fragments`. A Bun script can import it by path: `import { extractFragment } from '<instatic>/src/core/fragments'`.
- Format: `SiteFragmentSchema` (`format: 'instatic-fragment'`, `version: 1`) in `schema.ts`; `parseSiteFragment(unknown)` is the boundary.
- Package file: a zip with `fragment.json` (a theme: `theme.json`) + `media/<sha256>.<ext>` (`writeFragmentPackage` / `readFragmentPackage`, `writeThemePackage` / `readThemePackage`, fflate). Media bytes are never inlined in the JSON.
- Sources: `fragmentSourceFromBundleArchive(zipBytes)` (the Export site archive), `fragmentSourceFromBundle(bundle)` (manifest or JSON bundle), `fragmentSourceFromSite(site, { tables, rows, media })` (a live editor document).
- Pipeline: `extractFragment` → `parseSiteFragment` (or `readFragmentPackage`) → `planFragmentInsert` (pure) → `commitFragmentPlan` (server work, then ONE store transaction).
- Merge rule: the site always wins. Classes, components and tables match by name/slug and the site's version is reused untouched; tokens match by name and are only added when missing; everything added gets fresh ids.
- Editor entry point: Spotlight **Insert fragment from file…** (`editor.insertFragment`) opens `InsertFragmentModal`: pick a package, review the plan, Insert, read what was added. One Cmd+Z removes the whole insert.
- Plugin entry point: `api.editor.fragments.insert` / `.plan` (permission `editor.fragments`), the same plan and commit as the dialog with a caller-supplied `readMediaBytes` and a `placement`. See [plugin-system.md](plugin-system.md#inserting-site-fragments-and-applying-themes-editorfragments).
- Themes: `extractTheme` → `parseSiteTheme` (or `readThemePackage`) → `planThemeApply` (pure) → `commitThemePlan`. The one place the engine overwrites: the theme's colours, font tokens, scale groups and root custom properties replace the site's. Plugin entry point: `api.editor.fragments.applyTheme` / `.planTheme`.
- Paste, saved layouts, HTML import and site import do not use fragments and behave exactly as before.

---

## Where the code lives

```text
src/core/fragments/
├── index.ts          public barrel
├── schema.ts         SiteFragmentSchema, parseSiteFragment, FragmentParseError
├── source.ts         FragmentSource + fragmentSourceFrom{Bundle,BundleArchive,Site}
├── extract.ts        extractFragment (orchestrator, selection, components, links)
├── extractStyles.ts  framework stubs, @keyframes, outside dependencies, conditions
├── extractTokens.ts  var(--x) closure, classified by the framework's generators
├── extractData.ts    tables (loops, CMS forms) and media
├── siteVariables.ts  indexSiteVariables: which --vars a site defines, and from where
├── references.ts     string walkers: media paths, cms:page links, var(), table refs
├── mediaKeys.ts      sha256Hex (Web Crypto), mediaPackagePath
├── package.ts        writeFragmentPackage / readFragmentPackage
├── planTypes.ts      FragmentInsertTarget, FragmentInsertPlan, FragmentInsertReport
├── plan.ts           planFragmentInsert, FragmentInsertError
├── planTokens.ts     colours, scale steps, fonts, root custom properties
├── planData.ts       tables, referencedMedia
├── resolve.ts        resolveFragmentPlan (media URLs, table ids, font ids)
├── apply.ts          applyResolvedFragment (writes a resolved plan into a SiteDocument)
├── adapter.ts        FragmentAssetAdapter, FragmentInsertAdapter, ThemeApplyAdapter (interfaces only)
├── commit.ts         commitFragmentPlan, FragmentCommitError; resolveMedia + installFonts (shared with themes)
├── themeSchema.ts    SiteThemeSchema, parseSiteTheme
├── extractTheme.ts   extractTheme
├── planTheme.ts      planThemeApply, ThemeApplyPlan, ThemeApplyReport
├── applyTheme.ts     resolveThemePlan, applyResolvedTheme
├── commitTheme.ts    commitThemePlan
└── warnings.ts       FragmentWarning codes

src/admin/modals/InsertFragment/
├── InsertFragmentModal.tsx         pick → review → insert → report
├── FragmentReport.tsx              the review / result report
├── fragmentInsertFlow.ts           load file, plan against the open document, commit, toasts
├── themeApplyFlow.ts               plan a theme against the open site, commit, toasts
├── createFragmentInsertAdapter.ts  CMS API + editor store implementation of both adapters
├── pluginFragmentsHost.ts          fragment insert, preview styles and theme APIs
└── useBindPluginFragmentsApi.ts    binds that host into the plugin runtime while the editor is open

src/admin/pages/site/store/slices/fragmentsSlice.ts   insertFragment, applyTheme + dialog flag
src/admin/spotlight/commands/fragments.ts             editor.insertFragment
```

---

## The format

```ts
SiteFragment = {
  format: 'instatic-fragment', version: 1,
  kind: 'section' | 'page' | 'component',
  origin?: { source?, item?, build? },          // free-form provenance
  roots: string[],                              // section: 1..n siblings; page: its base.body; component: one instance
  nodes: Record<string, PageNode>,
  page?: { title, slug },                       // kind 'page'
  component?: { id, name },                     // kind 'component'
  optionalClassIds?: string[],                    // offer these shared classes in the editor
  styleRules: StyleRule[],                      // classes + ambient rules (framework utilities by name only)
  conditions: ConditionDef[],
  components: VisualComponent[],                // closure, nested refs included
  tokens: {
    colors: FrameworkColorToken[],              // full definitions, generation flags included
    fontTokens: FontToken[], fontFamilies: FontEntry[],
    typeSteps: { convention, step }[], spaceSteps: { convention, step }[],
    customProperties: Record<'--name', string>, // valued from the source :root/html/body rules
  },
  tables: { id, slug, name, kind: 'postType' | 'data', singularLabel, pluralLabel,
            routeBase, primaryFieldId, fields, rows?: { id, slug, status, cells }[] }[],
  media: { id, key?: sha256, path, filename, mimeType, sizeBytes?, width?, height?, alt?, src }[],
  links: { pageId, slug }[],
  outsideDependencies?: { selector, classes }[],
}
```

Every id is a SOURCE id. `media[].path` is the exact string the content uses (`/uploads/…`) and `media[].src` is where the bytes are (a package path, or a URL the caller resolves). A step names the framework group by its `namingConvention` (`text`, `space`), so `--text-xl` is `{ convention: 'text', step: 'xl' }`.

`parseSiteFragment` checks the TypeBox shape, then that roots resolve, node keys match ids, children resolve, trees are acyclic, the kind payload is present (a page has one `base.body` root; a component has one instance of `component.id`), and ids are unique.

---

## Extract: the closure

`extractFragment(source, selection, options?)` with `selection` = `{ pageId, rootNodeIds? }` (no `rootNodeIds` = the whole page) or `{ componentId }`. In a bundle a page id is its `pages` row id. Returns `{ fragment, mediaBytes, warnings }`; `mediaBytes` (by media id) is what `writeFragmentPackage` zips.

| Step | What is carried |
|---|---|
| Nodes | The selected subtrees, deep-copied. A component selection becomes one `base.visual-component-ref` with its slot instances. |
| Components | Every referenced Visual Component, transitively. Their trees feed every later step. |
| Classes | Every class a carried node or component uses. `framework:*` utilities carry only name + generated metadata; scoped module-style and regular rules carry whole. |
| Optional classes | Pass shared rule IDs in `options.optionalClassIds` to carry their styles and dependencies. Insertion adds or reuses these classes in the destination and preserves the node’s original class assignments. |
| Ambient rules | Every ambient rule whose selector names a carried class (`extractCssSelectorClasses`), and every `@keyframes` block a carried `animation` uses. |
| Outside dependencies | Rules that style the selection through a class only its ANCESTORS have (a page wrapper, the body's class), when the rightmost compound could match inside the selection. Reported, not carried. |
| Conditions | Non-viewport `contextStyles` keys of carried rules. |
| Tokens | Every `var(--x)` in carried rules and node content, classified by the framework's own generators (`indexSiteVariables`): colour (incl. `-50`, `-d-2`, `-l-1` variants) → the base token; type/space scale variable → the step; font token → the token and its family; other → the source root value (followed recursively). Framework utilities add their colour or step. Families named literally in `font-family` travel too. |
| Tables | Loops with `sourceId: 'data.rows'` carry `filters.tableId` with its rows; CMS forms (`mode: 'cms'`) carry `targetTableId` schema only. Dynamic bindings stay verbatim. |
| Media | Every library asset whose path occurs in carried content, every custom font file, and every media cell (incl. repeaters) of carried rows. With bytes, `key` = SHA-256 and `src` = `media/<key>.<ext>`. |
| Links | Every `cms:page:<id>` with the source page's slug. |

---

## Plan: the site always wins

`planFragmentInsert({ site, tables, document? }, fragment)` is pure. `document` (`{ kind: 'page', pageId }` or `{ kind: 'visualComponent', vcId }`) is required for sections and components. It returns a `FragmentInsertPlan` (everything to add, every id minted) with a `report`.

| What | Rule |
|---|---|
| Nodes | All new ids. |
| Classes | Matched by name. The site's class is reused as is, styles and all. A missing class is added with a fresh id after every existing rule, in the fragment's relative order (`createStyleRuleOrderAllocator`). Only classes the landing nodes and added components use are added. |
| Scoped classes | Cloned with a fresh id onto the new node id. |
| Framework utilities | Matched by name against the site's framework AFTER the token merge (`generateFrameworkUtilityClasses` on the merged settings), so a colour the insert adds brings its utilities. A name the site does not generate is dropped (warning). |
| Ambient rules | Matched by exact selector; the site's rule wins. Only rules naming a landing class (or no class, like `@keyframes`) are added. |
| Conditions | Matched by id; missing ones added. |
| Colours | Matched by normalised slug; existing never changes. A missing colour is added with the fragment's full definition, or, when the caller passes `colorSources` (`planFragmentInsert(target, fragment, { colorSources })`), with the values of the site colour it names (`report.colors.filled`). A variant the fragment reads that the site's colour does not generate is a warning. |
| Type / space steps | A missing scale group starts with the framework defaults in the fragment's naming convention, with variables available for the required range. A site with no configured scales or preferences uses the browser's normal rem size for conversion. Its root font size stays in the existing CSS cascade. Existing fluid groups extend at either end while preserving the base and every existing step's size. Disabled scales, unavailable manual steps, and gaps that would change existing sizes yield a warning. Site CSS can still override the generated variables. |
| Font tokens | Matched by variable; existing wins (a new site's seeded `font-heading`/`font-body`/`font-mono` roles are kept). A missing token is added; its family is reused by name or installed. Families are only installed when an added token binds to them or a carried rule names them. |
| Custom properties | Added only when the site defines no such variable (root rules, colours, scales, font tokens). They go into ONE engine-owned ambient `:root` rule (`origin.source === FRAGMENT_PROPERTIES_ORIGIN`); later inserts add to it. A user-authored `:root` rule is never edited. |
| Components | Matched by name (the storage slug `vcSlugFromName`); the site's component wins and instances point at it. Only components reached through added ones are added. Instances of components neither carried nor present are stripped (warning). |
| Tables | Matched by slug; the site's table wins, its rows are not touched and the fragment's rows are not added; fields it lacks (by id) are appended atomically against the current table schema. A missing table is created with schema and rows. Relation fields survive only when their target table is carried; relation cells never travel. |
| Media | Only what the landing content uses (rows of reused tables excluded). |
| Links | A `cms:page:<id>` whose slug the site has is remapped to that page (a page fragment's links to itself follow it); any other becomes `#` (reported). Links in rows of created tables are rewritten the same way. |
| Pages | Only a page fragment adds a page, with a unique slug (`uniquePageSlug`). |
| Guards | A second `base.outlet` in the document, or a component cycle in VC mode, throws `FragmentInsertError` (`outlet-conflict`, `component-cycle`), like inserting a saved layout. |

---

## Commit

`commitFragmentPlan(plan, adapter, { readMediaBytes, signal?, onProgress? })`:

```text
A. media    adapter.findMedia (matching SHA-256) or adapter.uploadMedia
B. fonts    adapter.installGoogleFont / adapter.registerCustomFont (from the uploaded files)
C. tables   adapter.createTable (+ createRow, published rows published), adapter.updateTableFields
D. resolveFragmentPlan   media paths → URLs, fragment table ids → created ids, family ids → installed ids
E. adapter.commit(resolved)   ONE store transaction
```

- A media or table failure throws `FragmentCommitError` before E: the document is untouched; uploads and tables already made stay (Media and Data workspaces show them). A font install failure is a warning; the token falls back to its stack.
- `signal` aborts at the next boundary, never after E started.
- The editor's E is `insertFragment(plan, placement?)` (`fragmentsSlice.ts`): `applyResolvedFragment` inside `mutateActiveTreeAndSite` (sections, components; first root selected) or `mutateSite` (pages), plus `reconcileFrameworkClasses` when a colour or step was added. One undo step; the change syncs through collab like any edit. The plan's `document` must still be the active one.
- Placement (`FragmentInsertPlacement`): `after-selection`, the default and the dialog's only mode, places it right after the selected element (`resolveSiblingInsertLocation`), or at the end of the document when nothing or the root is selected, never inside a selected container; `inside-selection` places it inside the selected container like a paste (`resolveInsertLocation`); `end` appends it to the document whatever is selected.
- The editor adapter runs every server write through `runStepUp` (creating a table needs a recent password).

---

## Inserting from a plugin

A plugin with `editor.fragments` calls `api.editor.fragments.insert({ fragment, readMediaBytes, placement?, signal?, onProgress?, silent? })` or the dry run `api.editor.fragments.plan({ fragment })`. Both run on the dialog's own functions (`planFragmentForEditor`, `commitFragmentForEditor` in `fragmentInsertFlow.ts`), so the merge rules, step-up prompt, undo step and result toast are the same. The plugin supplies the bytes (`readMediaBytes`), which is only called for media the plan adds that the library lacks. Failures resolve as `{ ok: false, stage, message }`; a fragment `parseSiteFragment` refuses rejects `insert`. Full API: [plugin-system.md](plugin-system.md#inserting-site-fragments-and-applying-themes-editorfragments).

`watchPreviewStyles` lets a plugin preview a fragment with the destination’s current shared styles, including classes that no page uses yet. The preview receives both the stylesheet and its exact selector bindings.

---

## Themes

A theme is a site's design variables without its content. Fragments never overwrite what a site has; a theme is the one place where overwriting is the point: applying it replaces the site's values.

```ts
SiteTheme = {
  format: 'instatic-theme', version: 1,
  origin?: { source?, item?, build? },
  colors: FrameworkColorToken[],                       // full definitions, generation flags included
  fontTokens: FontToken[], fontFamilies: FontEntry[],  // a token's familyId names one of fontFamilies
  typography: FrameworkTypographyGroup[],              // matched by namingConvention
  spacing: FrameworkSpacingGroup[],
  customProperties: Record<'--name', string>,          // from the root-scope ambient rules (:root, html, body)
  media: FragmentMedia[],                              // custom font files, assets a custom property points at
}
```

`parseSiteTheme` checks the shape, then that colour slugs, font token variables, family ids, scale conventions (per family) and media ids are unique and every token's `familyId` is in `fontFamilies`. Errors are `FragmentParseError`.

**Extract.** `extractTheme(source, { origin? })` takes the same sources as `extractFragment` and returns `{ theme, mediaBytes, warnings }`. Root custom properties come from `indexSiteVariables` (last root rule in cascade order wins); media from `collectMedia`, as for a fragment. A token bound to a family the library lacks travels without its `familyId` (`missing-font-family`).

**Plan.** `planThemeApply({ site }, theme)` is pure and returns a `ThemeApplyPlan` with a `ThemeApplyReport` (`before` → `after` for everything changed; a value equal to the site's is listed as `kept`, never as changed):

| What | Rule | Report |
|---|---|---|
| Colours | Matched by normalised slug. The site token keeps its id, slug, order and category and takes the theme's light and dark values, dark-mode flag and generation flags. A missing colour is added after the site's. | `colors.changed` (`slug`, `before`/`after` light, dark, dark-mode), `added`, `kept` |
| Font tokens | Matched by variable. The site token keeps its id, name and order, is rebound to the theme's family and takes its fallback stack. A missing token is added. The family is reused when the site has one of the same name, else installed (Google families through the Typography panel's installer, custom ones registered from their uploaded files). | `fonts.tokensRebound` (`variable`, `before`/`after` family name), `tokensAdded`, `tokensKept`, `familiesToInstall`, `familiesReused` |
| Scale groups | Matched by `namingConvention` per family. The site group keeps its id, name, order, class generators and disabled flag and takes the theme's mode, min, max (size and ratio), steps, base index and manual sizes. A missing group is added (without generators). Steps the replaced group loses are a `scale-step-removed` warning. | `scales.changed` (`family`, `convention`, `before`/`after` min/max size and ratio, steps, base step), `added`, `kept` |
| Custom properties | A property a site root-scope rule declares is overwritten in the rule that declares it (`indexSiteVariables().rootCustomPropertyRuleIds`). Anything else goes into the engine-owned `:root` rule (`FRAGMENT_PROPERTIES_ORIGIN`), created when missing. | `customProperties.changed` (`name`, `before`, `after`), `added`, `kept` |
| Media | Files of families to install and assets changed properties reference. | `media.total` (`uploaded` / `reused` after commit) |

Nodes, classes, pages, components and tables are never touched.

**Commit.** `commitThemePlan(plan, adapter, { readMediaBytes, signal?, onProgress? })` runs the fragment commit's own `resolveMedia` and `installFonts` (a `ThemeApplyAdapter` is the `FragmentAssetAdapter` plus `commit`), then `resolveThemePlan` (media URLs into property values, installed family ids into tokens), then ONE `adapter.commit(resolved)`. A failed upload throws `FragmentCommitError('media')` before the commit: the site is untouched. A family that fails to install is a `font-install-failed` warning: a rebound token keeps its current family, an added one falls back to its stack. The editor's commit is `applyTheme(resolved)` (`fragmentsSlice.ts`): `applyResolvedTheme` inside `mutateSite`, matching colours, tokens and groups again by slug, variable and convention, plus `reconcileFrameworkClasses` when a colour or scale group changed. One undo step reverts the whole theme.

Themes have no editor dialog: plugins apply them through `api.editor.fragments.applyTheme` ([plugin-system.md](plugin-system.md#inserting-site-fragments-and-applying-themes-editorfragments)).

---

## Writing a fragment from a script

```ts
import {
  extractFragment,
  fragmentSourceFromBundleArchive,
  writeFragmentPackage,
} from '<instatic>/src/core/fragments'

const source = fragmentSourceFromBundleArchive(new Uint8Array(await Bun.file('site.zip').arrayBuffer()))
const { fragment, mediaBytes, warnings } = await extractFragment(source, { pageId, rootNodeIds: [sectionId] })
await Bun.write('section.zip', writeFragmentPackage(fragment, mediaBytes))
```

Bun resolves the `@core/*` aliases from the repo's `tsconfig.json`. `planFragmentInsert` runs the same way against any `SiteDocument`. A theme is the same three lines with `extractTheme(source)` and `writeThemePackage(theme, mediaBytes)`.

---

## Forbidden patterns

| Pattern | Use instead |
|---|---|
| Overwriting a site class, component, token or table from a fragment | The site always wins; report what was kept (only a theme overwrites, and only design variables) |
| Inlining media bytes in `fragment.json` | `media[].src` + the package zip |
| Classifying `var(--x)` with a hand-written regex | `indexSiteVariables` (the framework's generators) |
| Writing inserted custom properties into a user's `:root` rule | The engine-owned rule (`FRAGMENT_PROPERTIES_ORIGIN`); a theme overwrites a property only in the root rule that already declares it |
| Store writes outside `adapter.commit` | One transaction, one undo step |
| React, admin or server imports anywhere in `src/core/fragments/` (even transitively) | Keep it headless; `fragments-headless.test.ts` |

---

## Related

- [editor.md](../editor.md) — Saved layouts (same-site snapshots, class match by id) and Spotlight
- [site-import.md](site-import.md) — whole-site imports; shares `createStyleRuleOrderAllocator`, `isRootScopeSelector` and `addMissingConditions` (`@core/page-tree`)
- [site-transfer.md](site-transfer.md) — the export archive `fragmentSourceFromBundleArchive` reads
- [visual-components.md](visual-components.md), [loops.md](loops.md), [cms-native-forms.md](cms-native-forms.md), [media.md](media.md)
- Source of truth: `src/core/fragments/schema.ts`, `src/core/fragments/plan.ts`, `src/core/fragments/commit.ts`, `src/core/fragments/themeSchema.ts`, `src/core/fragments/planTheme.ts`
- Tests: `src/__tests__/fragments/` (`theme.test.ts` for themes), `src/__tests__/editor-store/insertFragment.test.ts`, `src/__tests__/editor-store/applyTheme.test.ts`, `src/__tests__/admin/insertFragmentModal.test.tsx`, `src/__tests__/plugins/pluginFragmentsApi.test.ts`
- Gate: `src/__tests__/architecture/fragments-headless.test.ts`
