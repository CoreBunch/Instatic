# SEO Workspace Design

Design spec for the core SEO workspace, generated robots.txt/sitemap endpoints, and published metadata model.

Instatic needs SEO as a core publishing capability. Plugins can extend reporting and integrations, but the CMS itself must own correct metadata emission, generated crawl files, and a focused admin surface for editing page, content, and template SEO.

---

## TL;DR

- Add a first-party SEO workspace at `/admin/tools/seo`, reached from a new **Tools** navigation dropdown.
- Tools contains first-party utility screens such as SEO and future Redirects; plugin admin pages move under the same dropdown instead of occupying top-level nav slots.
- SEO v1 has three tabs in the existing `AdminPageLayout` pattern: **Meta**, **Robots.txt**, and **Sitemap**.
- Meta is the v1 build focus: a searchable target index on the right, and a sticky editable preview column on the left.
- The preview editor uses controlled `Input` / `Textarea` primitives styled as platform snippets, not raw `contentEditable`.
- SEO data is core structured data, not plugin-owned data: `title`, `description`, `canonicalUrl`, `noindex`, Open Graph fields, and X card fields.
- The publisher resolves fallbacks and emits search, canonical, robots, Open Graph, and X card tags.
- `GET /robots.txt` must be handled before public page rendering and always return `text/plain`.
- `GET /sitemap.xml` is generated from published routable pages and content rows.
- Google Search Console and dashboard widgets are later integrations that consume the core SEO model; they are not part of v1.

## Current State

The admin shell uses route-level workspaces in `src/admin/router.tsx` and renders first-party pages through `src/admin/AuthenticatedAdmin.tsx`. Tabbed admin pages such as AI, Users, and Account use `AdminPageLayout` with small tab buttons passed through the `tabs` slot:

- `src/admin/pages/ai/AiPage.tsx`
- `src/admin/pages/users/UsersPage.tsx`
- `src/admin/pages/account/AccountPage.tsx`
- `src/admin/layouts/AdminPageLayout/AdminPageLayout.tsx`

The toolbar navigation is shared by `src/admin/shared/AdminSectionNavigation/AdminSectionNavigation.tsx`. Plugin admin pages are currently collected from `listCmsPlugins()` and rendered as top-level nav links. Plugin page routes are declared as `/admin/plugins/:pluginId/:pageId` in `src/admin/router.tsx` and rendered by `src/admin/pages/plugins/PluginPage.tsx`.

Published HTML metadata is currently minimal. `src/core/publisher/render.ts` derives `<title>`, meta description, favicon, and `lang` from `site.settings` and the active page. Current site-wide fields live in `src/core/page-tree/siteSettings.ts` as `metaTitle`, `metaDescription`, `faviconUrl`, and `language`.

Content rows already include built-in SEO fields. The built-in field definitions live in `src/core/data/fields.ts`; the field IDs are exported from `src/core/data/schemas.ts` as `seoTitle` and `seoDescription`, and read by `src/core/data/cells.ts`. The Content workspace edits them through `src/admin/pages/content/components/ContentSettingsPanel/ContentSettingsPanel.tsx`.

There is no first-party robots.txt or sitemap endpoint. Public HTML requests flow through `server/router.ts` into `server/publish/publicRouter.ts`. Without a dedicated `GET /robots.txt` handler before public page rendering, `/robots.txt` can fall through to an HTML response in development, which makes Lighthouse parse HTML as robots text.

## Product Decision

SEO belongs in core. It affects the correctness of published output and crawlability, so the base CMS must provide the model, endpoints, publisher tags, and editing UI.

Plugins can add:

- Google Search Console connection.
- Dashboard widgets and charts.
- Keyword research, recommendations, redirects importers, and richer audits.
- Custom metadata transforms through existing publisher/plugin hooks where appropriate.

Plugins must not be required for:

- Basic title and description editing.
- Open Graph and X card tags.
- Robots.txt.
- Sitemap.xml.
- Canonical URLs and noindex controls.

## Navigation

Add a top-level **Tools** dropdown to the admin toolbar navigation.

First-party entries:

- SEO: `/admin/tools/seo`
- Redirects: future `/admin/tools/redirects`

Plugin admin pages:

- Move plugin-provided admin pages under Tools.
- Keep the existing plugin page renderer and route shape unless a route rename is part of implementation.
- The dropdown label for plugin pages uses `page.navLabel ?? page.title`, grouped by plugin name when there is more than one page per plugin.

Top-level navigation remains focused on primary workspaces:

- Dashboard
- Site
- Content
- Data
- Media
- Plugins
- Users
- AI
- Tools

## SEO Workspace

Route: `/admin/tools/seo`

Workspace type: regular `AdminPageLayout`, not canvas layout.

Tabs:

- Meta
- Robots.txt
- Sitemap

The page follows the current tab shell used by `src/admin/pages/ai/AiPage.tsx`, `src/admin/pages/users/UsersPage.tsx`, and `src/admin/pages/account/AccountPage.tsx`: the page component owns the active tab and delegates stateful work to tab components.

Suggested folder layout:

```text
src/admin/pages/seo/
|-- SeoPage.tsx
|-- SeoPage.module.css
|-- tabs/
|   |-- MetaTab.tsx
|   |-- RobotsTab.tsx
|   `-- SitemapTab.tsx
|-- components/
|   |-- SeoTargetIndex.tsx
|   |-- SeoPreviewEditor.tsx
|   |-- SearchSnippetPreview.tsx
|   |-- OpenGraphPreview.tsx
|   `-- XCardPreview.tsx
`-- hooks/
    |-- useSeoTargets.ts
    `-- useSeoDraft.ts
```

## Meta Tab UX

The Meta tab has two persistent columns.

Left column: sticky preview editor.

- Platform switcher: Search, Open Graph, X.
- Search preview includes editable title and description, with route/canonical shown read-only.
- Open Graph preview includes editable OG title, OG description, image picker, image alt, and type.
- X preview includes editable X title, X description, image picker, image alt, and card type.
- X fields are hidden behind a "Customize X preview" control until they differ from fallback values.
- Field quality hints are inline and local: missing title, long title, missing description, missing image alt, invalid canonical, noindex enabled.
- Save state is quiet and local: unsaved, saving, saved, error.

Right column: target index.

- Search bar at the top.
- Target filters: All, Pages, Posts, Templates, Issues.
- Dense rows, not cards.
- Each row shows display title, target type, route/template target, and compact health indicators for title, description, image, and indexing.
- Clicking a row activates that target in the sticky preview editor.

The right index is navigation and audit context. The left preview editor is the editing surface.

## Editable Preview Controls

Do not use raw `contentEditable` for v1.

Use controlled `Input` and `Textarea` primitives styled to look like the platform snippets. This gives the direct-manipulation feel while preserving:

- predictable selection behavior;
- paste handling;
- undo behavior;
- validation;
- accessibility;
- save timing;
- architecture gate compliance for admin controls.

The user feels like they are editing the snippet, but the implementation stays inside existing UI primitives from `src/ui/components/`.

## SEO Data Model

Introduce one structured SEO object used by pages, content rows, and template defaults.

```ts
export const SeoMetadataSchema = Type.Object({
  title: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  canonicalUrl: Type.Optional(Type.String()),
  noindex: Type.Optional(Type.Boolean()),

  ogTitle: Type.Optional(Type.String()),
  ogDescription: Type.Optional(Type.String()),
  ogImage: Type.Optional(Type.String()),
  ogImageAlt: Type.Optional(Type.String()),
  ogType: Type.Optional(Type.Union([
    Type.Literal('website'),
    Type.Literal('article'),
  ])),

  xTitle: Type.Optional(Type.String()),
  xDescription: Type.Optional(Type.String()),
  xImage: Type.Optional(Type.String()),
  xImageAlt: Type.Optional(Type.String()),
  xCard: Type.Optional(Type.Union([
    Type.Literal('summary'),
    Type.Literal('summary_large_image'),
  ])),
})
```

Derived type:

```ts
export type SeoMetadata = Static<typeof SeoMetadataSchema>
```

The schema lives in a new core module that can be imported by the publisher, admin persistence schemas, and server handlers without pulling in admin code: `src/core/seo/`.

## Storage

Pages and post-type rows currently store SEO as flat built-in fields: `seoTitle` and `seoDescription`. Replace those with one structured `seo` field.

Because the project is pre-release, do not preserve both systems for compatibility. Change the seeded fields, tests, admin readers/writers, and docs together.

Field shape:

- For `page` and `postType` tables, add a built-in field with id `seo` and type `seoMetadata`.
- Store the object in `cells_json.seo`.
- Add `SeoMetadataFieldSchema` to the data field union.
- Validate `cells_json.seo` with `SeoMetadataSchema` at write boundaries.
- Do not expose `seoMetadata` as a user-created custom field type.
- The field is built-in and non-deletable for pages/post types. Its editing surface is the SEO workspace, with optional lightweight summaries in Content/Site metadata panels.

Site defaults live under `site.settings.seo`:

```ts
{
  titlePattern?: string
  description?: string
  defaultOgImage?: string
  defaultOgImageAlt?: string
  defaultXCard?: 'summary' | 'summary_large_image'
}
```

Template defaults are stored on the template page or entry-template row as `seo` patterns. Patterns can reference tokens such as `{title}`, `{siteName}`, `{slug}`, and `{excerpt}`.

## Target Types

The Meta tab edits these target kinds:

| Kind | Source | Route |
| --- | --- | --- |
| Page | `pages` system table row | Page slug route, with `index` mapped to `/` |
| Post/content row | `postType` table row | `routeBase + slug` |
| Template default | Entry template page row | Not directly routable; applies to matching content rows |
| Site default | `site.settings.seo` | Fallback for every target |

V1 includes Pages, Posts/content rows, Templates, and one pinned Site defaults target at the top of the index.

## Publisher Output

The publisher resolves final metadata per public route and emits:

```html
<title>...</title>
<meta name="description" content="...">
<link rel="canonical" href="...">
<meta name="robots" content="noindex,nofollow">

<meta property="og:title" content="...">
<meta property="og:description" content="...">
<meta property="og:image" content="...">
<meta property="og:image:alt" content="...">
<meta property="og:type" content="website">
<meta property="og:url" content="...">
<meta property="og:site_name" content="...">

<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="...">
<meta name="twitter:description" content="...">
<meta name="twitter:image" content="...">
<meta name="twitter:image:alt" content="...">
```

Even though the UI labels the platform as X, the emitted tag names remain `twitter:*` because that is the current card metadata convention.

Fallback chain:

```ts
title = seo.title ?? template.titlePattern ?? page.title ?? row.title ?? site.name
description = seo.description ?? template.description ?? site.seo.description

ogTitle = seo.ogTitle ?? title
ogDescription = seo.ogDescription ?? description
ogImage = seo.ogImage ?? site.seo.defaultOgImage
ogImageAlt = seo.ogImageAlt ?? site.seo.defaultOgImageAlt
ogType = seo.ogType ?? (routeKind === 'row' ? 'article' : 'website')

xTitle = seo.xTitle ?? ogTitle
xDescription = seo.xDescription ?? ogDescription
xImage = seo.xImage ?? ogImage
xImageAlt = seo.xImageAlt ?? ogImageAlt
xCard = seo.xCard ?? site.seo.defaultXCard ?? (xImage ? 'summary_large_image' : 'summary')
```

Canonical URL is resolved from the public origin plus the route path unless `seo.canonicalUrl` is set. Validate user-provided canonical values as safe HTTP(S) URLs.

If `seo.noindex` is true, emit:

```html
<meta name="robots" content="noindex,nofollow">
```

The publisher changes belong near `src/core/publisher/render.ts`, but metadata resolution is extracted into a focused core helper so previews and published output share the same fallback logic.

## Robots.txt

Add a first-party `GET /robots.txt` handler before `tryServePublicRoute` in `server/router.ts`.

Default output:

```text
User-agent: *
Allow: /

Sitemap: <public-origin>/sitemap.xml
```

Rules:

- Response content type is `text/plain; charset=utf-8`.
- `robots.txt` never falls through to public page rendering.
- Sitemap line is included when sitemap generation is enabled.
- Robots settings live in `site.settings.seo.robots`.
- Advanced manual rule editing waits until after generated defaults are stable. V1 starts with generated defaults plus enable/disable indexing.

The Robots.txt tab initially previews the generated file and exposes the minimal controls needed to avoid invalid output.

## Sitemap

Add a first-party `GET /sitemap.xml` handler before public page rendering.

Generated sitemap includes:

- published routable pages;
- published post-type rows with route bases;
- no rows/pages marked `noindex`;
- canonical route URLs only, not redirects;
- last-modified timestamps when available.

Response content type:

```text
application/xml; charset=utf-8
```

The Sitemap tab initially previews inclusion counts and exposes enable/disable plus basic exclusion controls. Rich sitemap reporting belongs to the later reporting/dashboard work.

## Persistence API

Use TypeBox schemas for all request and response bodies.

Recommended CMS endpoints:

```text
GET  /admin/api/cms/seo/targets
PUT  /admin/api/cms/seo/targets/:kind/:id
GET  /admin/api/cms/seo/robots
PUT  /admin/api/cms/seo/robots
GET  /admin/api/cms/seo/sitemap
PUT  /admin/api/cms/seo/sitemap
```

`GET /seo/targets` returns the complete target index plus current metadata values needed by the selected-target editor. If payload size becomes large, paginate later; do not add pagination in v1 until there is a measured need.

Client calls use `apiRequest(path, { schema })` from `@core/http`, matching the boundary-validation rules in `docs/reference/typebox-patterns.md`.

Server request bodies use `readValidatedBody(req, Schema)` from `server/http.ts`.

## Permissions

Add SEO-specific capabilities:

- `seo.read`: open SEO workspace and read SEO metadata.
- `seo.manage`: edit metadata, robots settings, and sitemap settings.

The SEO endpoints still enforce target-level ownership:

- Reading targets requires the same read permissions as the underlying target plus site read.
- Editing page SEO requires page metadata/content edit permission.
- Editing robots/sitemap settings requires site settings edit permission.

Avoid hiding robots/sitemap under plugin permissions. These are core publishing controls.

## Error Handling

UI async handlers catch and surface errors with component state and `role="alert"`.

Console errors use prefixed messages such as:

```ts
console.error('[seo-page] save failed:', err)
```

User-visible error messages use `getErrorMessage(err, 'Unknown SEO error')` from `src/core/utils/errorMessage.ts`.

The target editor must never silently discard unsaved changes when switching targets. If a selected target is dirty, row selection either saves first or asks through an in-app confirmation surface, not `confirm()`.

## Testing

Core tests:

- Metadata resolver fallback chains.
- Published HTML emits search, canonical, robots, OG, and X tags.
- `noindex` suppresses sitemap inclusion.
- Sitemap contains published routable pages/content rows only.
- `robots.txt` is `text/plain` and never returns HTML.

Admin tests:

- SEO page tab switching.
- Meta target search/filter.
- Selecting a target updates the preview editor.
- Editing snippet fields writes the structured SEO object.
- X override fields fall back to Open Graph/search fields until customized.

Architecture tests:

- Add route/nav tests if Tools changes the expected admin route list.
- Update field/system-table tests if flat `seoTitle` / `seoDescription` fields are replaced by `seo`.
- Keep admin controls on shared UI primitives.

## Work Sequence

These are implementation batches, not separately shipped compatibility states. The branch lands after the model, publisher, endpoints, admin UI, tests, and docs all agree on the structured `seo` field.

Batch 1: model and storage.

- Add core SEO schema and metadata resolver.
- Replace flat `seoTitle` / `seoDescription` fields with structured `seo`.
- Update content/page admin code, AI content tools, tests, and docs.

Batch 2: public output.

- Add robots.txt handler.
- Add sitemap.xml handler.
- Update publisher metadata output.

Batch 3: admin SEO workspace.

- Add `/admin/tools/seo`.
- Add Tools dropdown.
- Move plugin admin page links into Tools.
- Build Meta tab target index and preview editor.

Later integrations:

- Redirects workspace.
- SEO audit widgets on Dashboard.
- Google Search Console connection.
- Rich local audit reports and duplicate metadata detection.

## Fixed Decisions

- Plugin admin pages keep the current `/admin/plugins/:pluginId/:pageId` route shape. Tools changes navigation grouping, not route identity.
- Structured SEO is represented as a dedicated built-in `seoMetadata` field type, not a generic user-created JSON field.
- Site defaults appear as a pinned target row in the Meta tab.
- Robots advanced manual editing waits until after v1 generated output is stable.

## Related

- `src/admin/router.tsx` - admin route table.
- `src/admin/AuthenticatedAdmin.tsx` - workspace component selection and preload list.
- `src/admin/shared/AdminSectionNavigation/AdminSectionNavigation.tsx` - current top-level nav and plugin admin page links.
- `src/admin/layouts/AdminPageLayout/AdminPageLayout.tsx` - page scaffold used by AI, Users, Account, Plugins, and plugin pages.
- `src/core/page-tree/siteSettings.ts` - current site settings schema.
- `src/core/data/fields.ts` - built-in content/page field definitions.
- `src/core/data/schemas.ts` - data field IDs and TypeBox schemas.
- `src/core/publisher/render.ts` - current published HTML metadata assembly.
- `server/router.ts` - request dispatch order for robots.txt and sitemap.xml.
- `server/publish/publicRouter.ts` - public HTML routing and static artifact fallback.
- `docs/editor.md` - admin shell, toolbar, settings modal, and workspace layout.
- `docs/features/publisher.md` - published route pipeline and HTML output.
- `docs/features/content-storage.md` - data_tables/data_rows storage model.
- `docs/reference/typebox-patterns.md` - request/response validation rules.
