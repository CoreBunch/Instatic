<div align="center">

# Instatic

**Own your site. Love building it.**

A self-hosted CMS where the visual editor, content engine, and publisher all live in one Bun server — and the pages it ships are clean enough to read in view-source.

<p>
  <a href="https://trendshift.io/repositories/66792?utm_source=repository-badge&utm_medium=badge&utm_campaign=badge-repository-66792" target="_blank" rel="noopener noreferrer">
    <img src="https://trendshift.io/api/badge/repositories/66792" alt="CoreBunch/Instatic | Trendshift" width="250" height="55">
  </a>
</p>

[![Release](https://img.shields.io/github/v/release/corebunch/instatic?color=black&labelColor=black)](https://github.com/corebunch/instatic/releases)
[![GitHub stars](https://img.shields.io/github/stars/corebunch/instatic?style=flat&label=stars&labelColor=555&color=ffd43b)](https://github.com/corebunch/instatic/stargazers)
[![License: MIT](https://img.shields.io/badge/license-MIT-black?labelColor=black&color=blue)](LICENSE)
[![Runtime: Bun](https://img.shields.io/badge/runtime-Bun-black?labelColor=black&color=f9f1e1)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-everywhere-black?labelColor=black&color=3178c6)](https://www.typescriptlang.org/)

[One-Click Deploy](#deploy-in-one-click) · [Quick Start](#quick-start) · [Docs](docs/README.md) · [Plugins](docs/features/plugin-system.md) · [Roadmap](#early-on-purpose)

<br>

<a href="https://www.youtube.com/watch?v=zyjCF_TaLlg">
  <img src="https://img.youtube.com/vi/zyjCF_TaLlg/maxresdefault.jpg" alt="Watch the Instatic interface demo on YouTube" width="100%">
</a>

*Watch the introductory video about Instatic on YouTube.*

</div>

<br>

A modern website usually means assembling a stack: a headless CMS, a framework, a host, a form service, an analytics vendor, an image CDN — each with its own bill, dashboard, and 2 a.m. outage. Instatic is the opposite bet. One Bun server holds the whole thing — the canvas editor, the content engine, media, auth, forms, plugins, and the publisher — and you run it wherever you like, backed by SQLite or Postgres.

What comes out the other end is the part most builders quietly compromise on: plain semantic HTML and compact CSS, with none of the editor's machinery left behind in the page. No framework runtime, no builder attributes, no div soup. The site loads like a static file because, most of the time, it is one.

**MIT. Self-hosted. Yours.**

<br>

## Deploy in one click

Railway is the fastest way to get Instatic live. Pick a template, hit the button, wait about two minutes. That's it. It generates the secret keys, attaches the storage volume, and sets up the health checks on its own. You never open a terminal.

<div align="center">

<img src="docs/assets/readme/railway-deploy.gif" alt="Deploying Instatic to Railway — from template to a live CMS in under a minute" width="80%">

*One minute to live. Unedited.*

</div>

<br>

| Provider | Database | Best for | Deploy |
|---|---|---|---|
| **Railway** · *Recommended* | SQLite | A single site — blog, portfolio, small business | [Deploy →](https://railway.com/deploy/instatic-cms-sqlite?referralCode=Zm9bVJ&utm_medium=integration&utm_source=template&utm_campaign=generic) |
| **Railway** | Postgres | Multiple authors, managed backups, room to grow | [Deploy →](https://railway.com/deploy/instatic-cms-postgres?referralCode=Zm9bVJ&utm_medium=integration&utm_source=template&utm_campaign=generic) |
| **Render** | — | — | *Coming soon* |
| **Fly.io** | — | — | *Coming soon* |
| **DigitalOcean** | — | — | *Coming soon* |

SQLite is the right default for most sites. Reach for Postgres when you've got a team of authors or want managed database backups.

### Updating is just a redeploy

When a new Instatic version is available, update by redeploying the latest image. Your database and uploads stay on the attached storage, so the app container can be replaced without rebuilding the site from scratch.

Prefer your own hardware? Instatic is a single Docker image:

```sh
INSTATIC_IMAGE=ghcr.io/corebunch/instatic:latest docker compose -f compose.prod.yml -f compose.sqlite.yml up -d
```

Full guides for VPS, Postgres, HTTPS with Caddy, Render, and backups are in [docs/deployment](docs/deployment/README.md).

<br>

## One tool, the whole life of a site

Most tools do one job and hand you off for the rest. You design in one place, build in another, keep content somewhere else, then bolt analytics on from a fourth. Instatic does all of it. Here's what's actually in the box.

### 🎨 Design

<img src="docs/assets/readme/design-framework.webp" alt="Core Framework scales inside Instatic — a fluid spacing scale with mathematical ratios, edited live next to the canvas" width="100%">

The editor is a real canvas, not a form with a preview pane stapled to it. You put several breakpoint frames side by side and edit them together. Change the desktop and the mobile frame reacts in the same view. When you'd rather work on the real thing, flip to live mode and edit a single full-size page in place.

The part nobody else has: **[Core Framework](https://coreframework.com) is built in.** It's the design-token engine thousands of WordPress pros already use every day, and here it's a core system, not a plugin you install and pray over.

- **Color tokens that generate their own shade scale.** Define one brand color, get the full set of tuned tints and shades automatically.
- **Type scales that are fluid and mathematical.** One ramp that scales with the viewport, instead of forty hand-picked font sizes you have to keep in sync.
- **Spacing scales** so every page and every breakpoint keeps the same rhythm.
- **A utility-class generator** that emits locked, generated classes into one small `framework.css`. No bloat, no duplicate rules, nothing you didn't ask for.

Your whole design system lives as data. Change one token and every page that uses it updates.

### 🧱 Build

<img src="docs/assets/readme/build-components.webp" alt="Editing a Visual Component — a typed text param with a default value, bound to a node in the component's own tree" width="100%">

- **Modules** are the building blocks: containers, text, images, buttons, video, lists, links, SVG, forms. Drag them onto the canvas and nest them however you want.
- **Visual Components** are reusable pieces with typed parameters and named slots. A parameter can be a string, number, boolean, color, image, URL, rich text, an enum, or a whole slot of content. Edit the component once and every instance on the site updates. Components that would reference themselves are blocked before they happen, so nothing eats its own tail.
- **Templates** handle the shared chrome. One layout for the whole site, separate layouts per post type, and a real 404 page you design yourself. Content flows into an outlet, so a header and footer get written once and wrap everything.
- **Loops** repeat a layout over a collection: your posts, your pages, your media, or anything a plugin exposes as a source. Give a loop a couple of variants and it alternates between them as it goes. Good for post lists, product grids, galleries.
- **Forms that belong to your CMS.** Build a form out of semantic fields and the submissions land in your own data tables. Instatic can read the fields you placed and create the matching table for you. No third-party form service, no embed, no monthly fee for a contact form.
- **An AI agent that actually edits the page.** Describe what you want and it builds it on the canvas as real, editable nodes, not a screenshot or a wall of code. It writes semantic HTML for structure and CSS for style, through the same import pipeline you use when you paste markup. 28 tools under the hood. Bring your own model: Claude, OpenAI, OpenRouter, or local Ollama. Your key, your model, your bill.
- **Imports that hold up.** Paste raw HTML and get editable nodes. Or drop a whole static site — HTML, CSS, images, fonts — and Super Import turns it into pages, style rules, design tokens, and media. Every conflict is shown to you before anything is written, and the entire import is a single undo.

### 🗂 Manage

<img src="docs/assets/readme/manage-media.webp" alt="The Media workspace — an OS-style file manager for every asset on the site" width="100%">

- **One content model under everything.** Pages, posts, components, custom collections, and any structured table you invent all live in the same store: `data_tables` and `data_rows`. There's no special-cased "pages" table hiding in a corner. Schemas, raw rows, imports, exports, and form submissions all sit in one consistent place.
- **A Data workspace where you design your own collections.** At `/admin/data` you create custom post types and custom data tables with their own fields, then work the rows in a spreadsheet-style grid: search, sort, filter, bulk publish, bulk export. Custom post types come with a real editorial workflow — draft, scheduled, published — and version history on the published copy. Plain data tables are simple grids you can point at anything: the submissions from a form, a product catalog, a lightweight CRM, a list of testimonials. And every table you build is a content source a loop can render. Define a "Team" table once, loop it onto your about page, done.
- **A content workspace for writing.** A focused surface for posts and collections, plus live mode so authors edit inside the real design of the site instead of a gray textarea.
- **A media workspace that works like a file manager.** Folders and smart folders, bulk operations, usage tracking so you know where a file is actually used, replacement workflows, and pluggable storage adapters when you outgrow local disk.
- **Access control that's real, not decorative.** Roles built from 36 capabilities, token-based sessions, TOTP two-factor with secrets encrypted at rest, account lockout with backoff after repeated failures, and step-up prompts before the dangerous stuff like deleting a user or signing out every device.
- **⌘K for everything.** A fuzzy command palette over the whole admin. Jump anywhere, do anything, without touching the mouse.
- **Drafts stay drafts.** Unpublished edits never leak to a visitor. What you didn't publish, they don't see.

### 📊 Analyze

<img src="docs/assets/readme/analyze-dashboard.webp" alt="The Instatic dashboard — site stats, activity feed, and status widgets on a customizable grid" width="100%">

- **A dashboard you arrange yourself.** A 12-column grid of tile widgets you can drag, resize, and rearrange. Add the ones you care about in customize mode, and the layout saves per user. Plugins can ship their own widgets into the same grid.
- **An audit log that doesn't forget.** Every meaningful admin action writes a row: logins, content changes, role edits, plugin lifecycle. It's append-only, so it's a real record of who did what and when, not something anyone can quietly rewrite.
- **Form data that's yours.** Submissions sit in your own tables. Query them, export them, build on them. No vendor in the middle.

This is the youngest pillar, and the one we're pushing hardest right now. First-party, privacy-respecting analytics are next. See the [roadmap](#early-on-purpose).

### 🔌 Extend

<!-- TODO shot — extend-plugins.webp: Plugins page showing a plugin's permission prompts.
<img src="docs/assets/readme/extend-plugins.webp" alt="The plugin system — sandboxed, permissioned, first-class" width="100%">
-->

Every CMS has plugins. The difference here is where they run.

An Instatic plugin is a zip package with a manifest, and it runs inside a **QuickJS-WASM sandbox**. No filesystem. No environment variables. No network at all, unless the site owner grants it, one host at a time. A plugin can't read your secrets or phone home, because the sandbox never hands it the door. The classic "a plugin took down my site and emailed the database to a stranger" story doesn't run here.

Inside that sandbox the SDK is genuinely capable. A plugin can add:

- HTTP routes and its own admin pages
- Storage and scheduled background jobs
- Loop data sources, so your content loops can pull from anywhere
- Canvas modules — new blocks that show up in the editor
- Media storage adapters and frontend assets
- Lifecycle hooks across install, activation, and beyond

Start with the [plugin system docs](docs/features/plugin-system.md) and the [template plugin](examples/plugins/template/README.md).

<br>

## Fast because there's almost nothing to load

<!-- TODO shot — clean-output.webp: devtools view-source of a published page next to the rendered page.
<img src="docs/assets/readme/clean-output.webp" alt="A published Instatic page and its source — semantic HTML, compact CSS" width="100%">
-->

A published Instatic page is mostly just a file sitting on disk. No framework to boot, no hydration step, no database round-trip on the common path. The browser pulls down semantic HTML and a compact stylesheet, and it's done. There's barely anything between the visitor and the content, so the pages feel instant.

That speed isn't a setting you tune. It falls out of how publishing works, in three layers you never have to think about:

- **Static pages are baked straight to disk when you publish** and swapped in atomically. Visitors are served a file, not a render.
- **Routes that genuinely change** hit an in-memory cache that's wiped wholesale on every publish, so nobody ever sees a stale page.
- **The few truly per-visitor parts** are detected automatically and lazy-loaded by a runtime that weighs about 0.7 kB. Smaller than this paragraph.

What comes out the other end is plain HTML and compact CSS, all the way down. Nothing from the editor rides along: no React on your public pages, no editor runtime, no framework in the markup. And because it's just HTML and CSS, nothing holds your site hostage — you can read it, host it anywhere, or take it and leave. Full design: [the publisher](docs/features/publisher.md).

<br>

## Quick start

You need [Bun](https://bun.sh). Nothing else. The default dev setup runs on SQLite, so there are no extra services to stand up.

```sh
git clone https://github.com/corebunch/instatic.git
cd instatic
bun install
bun run dev
```

Open `http://localhost:5173`. The first visit walks you through creating your site and your owner account.

Want to see it the way it actually ships? `bun run start` builds the admin and serves it from the Bun server at `http://localhost:3001/admin`.

> **Backups, in one sentence:** back up the database (a Postgres dump or the SQLite file) and the uploads folder, and you've backed up the whole site — [details](docs/deployment/backup-restore.md).

<br>

## Who's behind this

We're the team behind **[Motion.page](https://motion.page)** and **[Core Framework](https://coreframework.com)** — tools that thousands of people use to build websites for a living, mostly in the WordPress world.

We spent years making other platforms more bearable. At some point the obvious question wouldn't go away: what if the thing underneath was just right to begin with? No legacy to work around, no markup we're not allowed to touch, no business model that depends on keeping your site where we can see it.

So we built Instatic. And we brought Core Framework along, wired in as a core system, so the color shades, type scales, spacing, and utility classes our users already rely on are part of the product — not an add-on you install and hope for the best.

<br>

## Early, on purpose

Here's the honest part: this is version 0.0.x.

Everything above — the canvas, Core Framework, the universal content model, the sandboxed plugins, the AI agent, forms, loops, templates, media, MFA, the audit log, one-click deploy, the clean publisher — is the starting line, not the finish. What's coming:

- **Real analytics.** First-party and privacy-respecting, to round out the Analyze pillar.
- **A bigger module and plugin ecosystem.** More first-party blocks, more SDK surface, more examples to copy from.
- **A sharper AI agent.** More tools, deeper awareness of your actual site.
- **Everything tighter.** We're pre-1.0 on purpose. It's the cheapest time to throw out bad ideas and keep the architecture clean.

APIs and workflows can still shift before 1.0. If that makes you nervous, wait for 1.0 — no hard feelings. If you'd rather help shape what site ownership looks like for the next twenty years, now's the good seat.

<br>

## For developers

One Bun server. A React admin built with Vite. A publisher that emits pages you'd be happy to have written yourself.

| | |
|---|---|
| **Runtime** | Bun, for both server and tooling |
| **Language** | TypeScript everywhere |
| **Admin app** | React 19 (React Compiler on), Vite, Zustand + Mutative, CodeMirror, dnd-kit |
| **Server** | `Bun.serve` with a hand-written router |
| **Database** | SQLite or Postgres — one `DbClient` interface, picked by `DATABASE_URL` |
| **Validation** | TypeBox at every untyped boundary; schemas are the source of truth |
| **Plugins** | QuickJS-WASM sandbox, owner-granted permissions |
| **AI** | Provider-agnostic drivers over raw HTTP/SSE, no vendor SDKs |
| **Output** | Semantic HTML, compact CSS, baked static files plus auto-detected dynamic holes |

The codebase is opinionated, and the opinions are enforced in code. Architectural rules live in `src/__tests__/architecture/` as actual tests, so the structure that keeps the output clean can't quietly rot.

```sh
bun run build   # tsc -b && vite build
bun test
bun run lint
```

Dig in: [docs index](docs/README.md) · [architecture](docs/architecture.md) · [editor](docs/editor.md) · [server](docs/server.md) · [publisher](docs/features/publisher.md) · [plugin system](docs/features/plugin-system.md)

<br>

## Thanks

Instatic's interface uses [Pixelarticons](https://pixelarticons.com/) by Gerrit Halfmann. Thanks to Gerrit for a genuinely distinctive icon set, and for kindly letting us use it in an open-source project.

## License

MIT. See [LICENSE](LICENSE). No tiers, no open-core asterisks, no "contact sales."
