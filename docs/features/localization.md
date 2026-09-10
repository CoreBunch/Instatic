# Localization

Languages, translated content and independent publication of pages and CMS entries.

A logical content row has one identity and optional language drafts; a missing language draft inherits its source during authoring. The editor shares structure and design while resolving sparse content overrides. Publishing freezes a selected language version; editing and source-language inheritance cannot silently change an existing public release.

---

## TL;DR

- Configure languages in **Settings → Languages**. The source language uses the root URL; additional languages have an explicit prefix, direction and online switch. New languages start offline.
- Choose the active language in the Site or Content toolbar. Content inherits from the source until overridden. Shared structure and styles are edited in the source language.
- **Publish pages…** selects page-language pairs explicitly. **Languages and publication** controls an individual page or entry in every language. Unselected and offline variants retain their state.
- Source-language withdrawal does not withdraw other languages. Disabling a whole language hides all its public variants without deleting their drafts or versions.
- Scheduling freezes the current content, URL and design revision. Later edits remain drafts; an existing live version remains live until the scheduled release. Schedules in a disabled language pause until that language is enabled.
- Published URLs, links, lists, switchers, fragments and SEO resolve through the same live inventory. Missing/offline variants never produce a guessed public URL.
- Source of truth: `src/core/localization-schema/`, `src/core/localization/`, `src/core/localization-routing/`, `server/repositories/localization/`.

## Content model

Migration `027` in both `server/db/migrations-pg.ts` and `server/db/migrations-sqlite.ts` adds localization storage and backfills the source language. Existing rows, version IDs, version cells, runtime assets and site snapshot references are retained. Older page versions may contain only title and slug; their published tree still comes from the original `site_snapshots` join. Migration does not replace those historical bodies with the current draft.

| Storage | Responsibility |
|---|---|
| `site_locales` | Stable language ID, BCP 47 code, name, path prefix, direction, source flag and availability |
| `data_rows` | Logical identity, shared fields, ownership and shared tree structure |
| `data_row_localizations` | Sparse draft cells, slug, availability, active version, frozen schedule, translation review metadata and sync sequence |
| `data_row_versions` | Immutable resolved content, language, public path and site snapshot reference |
| `data_table_localizations` | Per-language collection route base |

The source language uses the same localization record shape as translations. Public page and post-type URL slugs are always managed per language; their field editor cannot promise a shared routing value. The dedicated variant `slug` is canonical: writers normalize any existing slug cell to it, sparse absence remains absent, and projected slug controls, lookups and filters show that same value. Once a variant exists, its routing slug is independent of later source slug changes. Component and layout identifiers remain shared. `getDataRow` and `listDataRows` in `server/repositories/data/rows/` return the selected projection together with shared cells and localization metadata. Omitted language means the configured source; an explicitly unknown language is an error.

`DataField.localization` is `shared` or `localized`. Field-mode changes and moves between collections with different field modes use `server/repositories/data/tableFieldLocalization.ts` to preserve source values and dormant translations. Structural tree fields and internal component schemas cannot be made independently structural per language.

## Inheritance and review

`src/core/localization/` resolves shared cells → source overrides → selected overrides. Property absence means inheritance; explicit empty strings and null values remain intentional content. Tree overlays contain node content properties and visibility, never a second tree hierarchy. Deleted shared nodes cannot be resurrected by an old override.

Visual Component parameter definitions remain shared. Localizable content defaults and instance values use the parameter policy in `src/core/visualComponents/parameterLocalization.ts`; style and structural parameters stay shared.

`ContentLanguagesDialog` shows missing, inherited, needs-review and reviewed fields. **Use source** removes the override. **Mark reviewed** records the current source fingerprint; a later source change returns that field to needs-review without replacing the translation. Editing a translation also marks that field for review while retaining the reviews of untouched fields. The translation API also supports resetting one tree node property; review is field-wide.

## Authoring and collaboration

- `GET /admin/api/cms/site-document?localeId=…` assembles the projected document and sync metadata in one transaction. `getDraftSiteDocumentInTx` is the assembly entrypoint for existing transactions; never nest the transactional wrapper.
- `src/admin/pages/site/store/slices/site/` holds the selected locale and projects localized documents. `src/core/collab/docIds.ts` distinguishes shared structural documents from locale overlays; undo belongs to the active document.
- `server/collab/localizationGuard.ts` validates localized updates before persistence. An editor cannot use a translated overlay to change shared structure or styles.
- `src/admin/pages/content/hooks/useContentWorkspace.ts` reads and writes an explicit language. Content previews, loop previews and binding pickers carry that same selection.
- Collection settings expose translated route bases. Draft slug or base changes take effect only when the affected variants are published.
- Moving a logical entry between collections withdraws all its language versions and cancels schedules because its schema/template context changes. The UI explains this before the move.

## Publication and routes

`server/publish/publishedRoutes.ts` builds the live inventory from enabled locales and online variants pointing at immutable versions. `server/publish/publicRouter.ts` checks it before static artefacts, cached rendering and dynamic routes. Entry lists and route-aware fragments apply the same availability rules.

`server/publish/publishSite.ts` publishes explicit page-language pairs. `server/publish/publishRow.ts` publishes one selected row language. Publishing resolves inherited content and pins its shared site dependencies. Retraction and whole-language availability changes rebuild dependent live pages, switchers, alternates and the sitemap from those pinned releases, so updated menus/lists do not publish unrelated drafts.

CMS entries use the latest published site/template snapshot of their language. Publish a matching template before publishing an entry with a public route. **Republish entry** in the Content publishing menu adopts the current published template without withdrawing the entry first. An entry schedule pins that published template; a page schedule captures its current draft design. Technical templates have no direct public URL.

The `base.language-switcher` module links only to live equivalents of the current logical content. `server/publish/localizedSeo.ts` emits HTML language/direction, canonical and reciprocal alternates; sitemap entries come from the same inventory. Configure **Public website URL** for absolute canonical URLs and sitemap hosts. Each locale can use its own published 404 projection. Changing a language code, direction, URL prefix or collection route base remains a draft routing/content change until the affected variant is published again; availability changes apply immediately.

Public forms carry the originating logical content ID, language, version and public path. `server/forms/handler.ts` resolves that exact current published route before accepting a challenge/submission. A withdrawn or replaced release cannot continue submitting through an old page token.

## Integrations and permissions

`server/handlers/cms/localeContext.ts` validates HTTP language context. Creating/editing language configuration requires `site.structure.edit`; changing availability additionally requires `pages.publish`. Generic collections (`kind=data`) remain internal data without the page/post-type public release lifecycle. Their values can be localized and inherit the source during reads. Row access retains existing ownership and collection permissions; publish and schedule actions retain step-up authentication.

Plugin content calls expose locale selection through the existing permission-gated SDK. AI and MCP workspaces expose their selected language; mutation tools reject a stale or conflicting locale instead of applying the operation elsewhere. See `docs/features/plugin-system.md` and `docs/features/mcp-connectors.md`.

Bundles include locale identities, sparse drafts and the exact immutable dependencies needed by published/scheduled versions. Import validates identity conflicts and applies the bundle transactionally. See `docs/features/site-transfer.md`.

## Related

- `docs/features/publisher.md` — release snapshots, route inventory and dependency rebaking.
- `docs/features/site-shell.md` — editor synchronization and collaborative document ownership.
- `docs/features/content-storage.md` — logical rows and field storage.
- `docs/features/site-transfer.md` — bundle lifecycle and permissions.
- `src/core/localization/__tests__/` — inheritance, source review and sparse tree policies.
- `src/__tests__/server/localizedPublication.test.ts` and `localizedRouteInventory.test.ts` — independent availability, pinned releases and route collisions.
- `src/__tests__/server/siteDocumentSave.test.ts` — coherent reads and transactional writes.
- `src/__tests__/collab/localization.test.ts` and `src/__tests__/server/localizedCollabGuard.test.ts` — locale documents, undo and server guards.
