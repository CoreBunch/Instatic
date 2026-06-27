# SEO & AEO

Search and answer-engine optimization is a core publishing capability:
structured metadata per page/post, site-wide defaults with title patterns,
Open Graph + X cards, schema.org JSON-LD, generated `robots.txt` with
AI-crawler controls, `sitemap.xml`, and an admin workspace at
`/admin/tools/seo` with AI-assisted copy suggestions.

Spec history: `docs/superpowers/specs/2026-06-12-seo-workspace-design.md`.

---

## The model

One engine module owns everything: **`src/core/seo/`** (barrel-gated).

| File | Responsibility |
| --- | --- |
| `schema.ts` | `SeoMetadataSchema` (per-target object stored in `cells_json.seo`), `SiteSeoSettingsSchema` (`site.settings.seo`: title pattern, description, default social image, X handle/card, organization, robots, sitemap) |
| `resolve.ts` | `resolveSeoMetadata` — the single fallback engine (see below) |
| `jsonLd.ts` | `buildJsonLdEntities` (`WebSite`, `Organization`, `Article`, `BreadcrumbList`) + `serializeJsonLd` (escapes `</script`, `<!--`) |
| `robots.ts` | `generateRobotsTxt` — serves the stored body verbatim (`SeoRobotsSettings.content`), falling back to `DEFAULT_ROBOTS_TEMPLATE` when empty and appending the origin-resolved `Sitemap:` line unless the body already has one. `SYSTEM_DISALLOW_PATHS` seeds the default template + the tab's "block system paths" shortcut. `blockAll` serves a bare `Disallow: /` for preview hosts. |
| `robotsAnalysis.ts` | `lintRobotsTxt` (flags unknown directives, rules before any `User-agent`, malformed values) + `matchRobots` (is a path crawlable for a UA — Google longest-match, `Allow` tie-break, `*`/`$` support). Powers the Robots tab's issue list and URL tester, plus the contextual recommendations. |
| `aiCrawlers.ts` | The AI-crawler user-agent lists the Robots tab's "block AI crawlers" shortcuts insert (training + answer groups) |
| `health.ts` | `computeSeoReport` — per-target weighted checks + 0–100 score (`aggregateSeoScore`, `seoScoreTier` for the site-wide rollup and good/fair/poor tiers) |
| `lengthMeter.ts` | Approximate pixel-width metering with an ideal band (~580px title / ~990px description budgets; "ok" only between the too-short minimum and the budget) |

### Storage

- **Targets** (`page` + `postType` rows): one built-in `seoMetadata` field with
  id `seo`; the structured object lives in `cells_json.seo`. Not offered as a
  user-created custom field type; not bindable; not form-submittable.
- **Site defaults**: `site.settings.seo` (replaced the legacy
  `metaTitle`/`metaDescription` settings).
- **Templates**: an entry template page row's `seo.title`/`seo.description`
  act as token patterns for every matching post. Only entry templates
  (postTypes targets) are SEO targets — `everywhere` layout templates have
  no route or content of their own, so the target index excludes them (the
  wrapped pages own the metadata).

### Resolution — two-stage title

`resolveSeoMetadata` is shared by the publisher, the admin previews, and the
score reports — what the editor shows IS what gets emitted.

```
baseTitle  = target.seo.title ?? row/page title
pattern    = template.seo.title ?? site.seo.titlePattern      // {source.field} tokens
title      = explicit target title (pattern skipped)
           | interpolate(pattern)                              // shared token engine
           | baseTitle ?? site.name
```

Patterns use the existing `{source.field}` token engine
(`src/core/templates/tokenInterpolation.ts`) — `{page.title}`, `{site.name}`,
`{currentEntry.title}`. There is no second token grammar.

Social fields fall back search → OG → X. `noindex` emits `noindex` only
(never a silent `nofollow`).

### Absolute URLs

Canonical, `og:url`, sitemap `<loc>`, and origin-dependent JSON-LD use the
configured public origin (`PUBLIC_ORIGINS` env → `canonicalPublicOrigin()` in
`server/auth/security.ts`). Static HTML is baked at publish time, so with no
origin configured those tags are **omitted** — never a guessed host. The
dynamic `robots.txt`/`sitemap.xml` endpoints fall back to the request origin.

## Published output

`src/core/publisher/seoHead.ts` builds the head: title, description,
canonical, robots, OG (incl. `og:locale`, `og:site_name`, `article:*_time`),
X cards (`twitter:*` tag names), and one
`<script type="application/ld+json">` per entity. The server resolves the
payload per route in `server/publish/publicRenderer.ts` (page SEO from the
snapshot, row SEO from the published version's cells + entry-template
patterns); `publishPage` has an internal fallback so previews/exports run the
same resolver.

JSON-LD (zero-config in v1): `WebSite` + `Organization` on the homepage,
`Article` on row routes, `BreadcrumbList` on routes deeper than one segment.
Noindex targets emit none.

## robots.txt and sitemap.xml

`server/publish/seoEndpoints.ts`, dispatched by `server/router.ts` BEFORE
static assets and public rendering. Both generate from the **published
snapshot** and cache keyed by `publishVersion` — SEO follows the publish
lifecycle (edit → publish → live).

- `robots.txt` (`text/plain`): the admin-authored body (or the default
  template — allow all + system-path disallows for `/admin` + `/_instatic/`),
  with a `Sitemap:` line appended unless the body already declares one. The
  Robots tab's shortcuts compose common bodies (block AI crawlers from
  `AI_TRAINING_CRAWLERS` / `AI_ANSWER_CRAWLERS`, block system paths, block
  everything).
- `sitemap.xml` (`application/xml`): published routable pages + post rows,
  excluding templates, `noindex` targets, and
  `site.settings.seo.sitemap.excludedTargets`; `<lastmod>` from publish
  timestamps. Disabled ⇒ 404.

### Environment protection

`requestHostIsCanonical(req)` (in `server/auth/security.ts`) compares the
request `Host` (trusted; never `X-Forwarded-*`) against the configured
`PUBLIC_ORIGINS`. On a non-canonical host — a preview/staging deploy whose
host isn't a configured origin — `robots.txt` serves a blanket `Disallow: /`
(uncached) and the static-asset, upload, and public-page handlers stamp
`X-Robots-Tag: noindex, nofollow`, so a non-production deploy can't be
indexed even via a direct asset URL. With no public origin configured the
predicate returns `null` and behavior is unchanged (local dev / unconfigured
installs are unaffected).

## Admin workspace — `/admin/tools/seo`

`src/admin/pages/seo/`. Reached from the **Tools** nav dropdown
(`AdminSectionNavigation`), which also hosts plugin admin pages (their
`/admin/plugins/:pluginId/:pageId` routes are unchanged — only nav grouping
moved).

Save/publish lives in the **toolbar**, like the Site and Content workspaces:
the active editor (target editor, site defaults, robots, sitemap) registers
itself on a save bridge (`hooks/useSeoSaveBridge.ts`) and `SeoToolbar`
renders the shared `PublishActionGroup` (status dot, split "Save & publish"
button, Save draft + Open live URL menu). Posts publish through the
incremental row endpoint; everything else runs the step-up-gated full site
publish — the same machinery as the Site toolbar, not a parallel path.

- **Meta tab** — one flat three-column grid. Left: site-wide SEO score in a
  `LiquidProgressRing` (tier-toned liquid, computed from one shared
  `indexSeoTargets` pass) over the target index (search,
  All/Pages/Posts/Templates/Issues filters, clickable issues line, tiered
  score pills per row, ↑/↓/Enter + `/` keyboard nav, pinned Site defaults
  row). Middle: the editor form with a live score chip and a clickable
  improvements list (each row focuses the field it describes). Right: the
  sticky Search / Open Graph / X / Schema preview rail — the editors render
  form + rail as fragment siblings so the grid stays flat.
  Controlled `Input`/`Textarea` primitives
  (no contentEditable); empty fields show their RESOLVED fallback as
  placeholder; title/description carry ideal-band pixel meters (green only
  inside the band; inherited values render muted with an Inherited/Missing
  tag instead of character counts); images pick from the media library; X
  fields hide behind "Customize X preview" until set; switching targets
  while dirty asks via an in-app dialog. The Schema view pretty-prints the
  exact JSON-LD the publisher will emit.
- **Robots.txt tab** — the file is edited directly: an editable CodeMirror
  surface (`SeoCodeEditor`, saving `seo.robots.content`) is the main column,
  with an assistant rail on the left — contextual recommendations (block AI
  crawlers / system paths, "all crawlers blocked" warning) that double as
  one-click document edits, quick-insert shortcuts, a lint issue list
  (`lintRobotsTxt`), and a "test a URL" checker (`matchRobots`). No public-
  origin notices (production always sets `PUBLIC_ORIGINS`).
- **Sitemap tab** — same shape as Robots: an assistant rail (heading,
  the Generate toggle + inclusion count) beside the per-target
  include/exclude list as the main column (noindex targets shown disabled
  with the reason). Off ⇒ a quiet disabled state.

All workspace forms render rows through the shared
`components/SeoFormRow.tsx` (`SeoFormRow` / `SeoSwitchRow`): a two-column
grid with muted labels left and the control stack right.

### AI suggestions

The sparkle on title/description/OG/X inputs calls
`POST /admin/api/cms/seo/generate` (`server/handlers/cms/seoGenerate.ts`):
one tool-less driver call through the existing `server/ai` stack (provider +
model from the `content`, falling back to `site`, scope default), returning
three suggestions rendered as tappable bubbles with **More options**
(exclude-aware regenerate) and **Reject**. Length budgets ride the prompt.
Suggestions fill the input through the normal dirty/save flow — nothing
auto-saves.

## API and permissions

`server/handlers/cms/seo.ts` — `/admin/api/cms/seo/*`:

| Route | Capability | Notes |
| --- | --- | --- |
| `GET /seo/targets` | `seo.read` | Full target index + site SEO + configured origin (draft cells) |
| `PUT /seo/targets/:kind/:id` | `seo.manage` + target ownership | `pages.edit` for page/template rows; `content.edit.any`/`content.manage` for post rows |
| `PUT /seo/site` | `seo.manage` | Site defaults + robots + sitemap settings (one object) |
| `POST /seo/generate` | `seo.manage` + `ai.chat` | AI suggestions |

`seo.read` gates the workspace; `seo.manage` gates writes. Publishing
additionally requires the real publish capability for the scope
(`content.publish.*` for post rows, `pages.publish` for the site publish).
Score reports are computed client-side with the shared core resolver, so the
scoreboard, the index, the editor, and the published output agree by
construction.

## Tests

- `src/core/seo/__tests__/` — resolver fallback chains, JSON-LD building +
  escaping, robots generation, score reports.
- `src/__tests__/publisher/render.test.ts` — emitted head tags.
- `src/__tests__/server/seoEndpoints.test.ts` — robots/sitemap endpoints +
  version caching.
- `src/__tests__/server/seoHandler.test.ts` / `seoGenerate.test.ts` —
  API + capability gates (real SQLite via the capability harness).
- `src/__tests__/admin/seoWorkspace.test.tsx` — Meta/Robots tabs + Tools nav.
