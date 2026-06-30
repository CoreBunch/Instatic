# Instatic Docs

The documentation tree for Instatic. This index tells you what to read, in what order, and where to look for what.

If you're an agent: start at `CLAUDE.md` (repo root) for the rules, then come here for the explanations.
If you're a human contributor: start with [`architecture.md`](architecture.md), then read whichever feature or reference page is closest to what you're changing.

---

## How to read this tree

```text
docs/
├── README.md                   ← this file (start here)
├── CONVENTIONS.md              ← how docs in this repo are written (read before authoring)
│
├── architecture.md             ← system overview (start here for orientation)
├── design.md                   ← visual design system (tokens, surfaces, components)
├── server.md                   ← server-side deep dive
├── editor.md                   ← admin + visual editor deep dive
│
├── features/                   ← "what X is and how it works" (per-feature)
│   ├── plugin-system.md            ← plugin SDK, sandbox, lifecycle, permissions
│   ├── publisher.md                ← page tree → static HTML/CSS pipeline
│   ├── visual-components.md        ← VCs, slots, params, instantiation
│   ├── content-storage.md          ← data_tables + data_rows (the universal store)
│   ├── content-workspace.md        ← Content workspace: collections, entries, body editor
│   ├── auth-and-access.md          ← sessions, MFA, capabilities, roles
│   ├── site-shell.md               ← site config (breakpoints, classes, files, deps)
│   ├── modules.md                  ← module engine + first-party blocks
│   ├── data-workspace.md           ← Data workspace: table schema + field management UI
│   ├── dashboard.md                ← Dashboard workspace + widget registry
│   ├── spotlight.md                ← Cmd+K command palette
│   ├── agent.md                    ← AI agent integration
│   ├── templates.md                ← entry templates + dynamic bindings
│   ├── loops.md                    ← base.loop + loop sources
│   ├── cms-native-forms.md         ← visual form primitives + data_rows submissions
│   ├── media.md                    ← Media workspace + storage adapters
│   ├── audit-log.md                ← audit_events catalog
│   ├── site-transfer.md            ← export / import CMS bundles
│   ├── site-import.md              ← Super Import (static sites → CMS)
│   ├── html-import.md              ← paste / import HTML into the page tree
│   ├── editor-preferences.md       ← catalog-driven editor prefs
│   └── canvas-iframe-per-frame.md  ← per-breakpoint iframe rendering
│
├── reference/                  ← short cookbook pages for primitives + patterns
│   ├── page-tree.md                ← NodeTree<TNode> primitive
│   ├── database-dialects.md        ← PG vs SQLite rules
│   ├── typebox-patterns.md         ← boundary validation patterns
│   ├── ui-primitives.md            ← Button/Input/etc. usage cookbook
│   ├── design-tokens.md            ← complete CSS token catalog
│   ├── module-engine.md            ← defining a new module
│   ├── canvas-dnd.md               ← drag-and-drop patterns
│   ├── admin-router.md             ← in-house router usage
│   ├── css-class-registry.md       ← user CSS classes + scoped classes
│   ├── capabilities.md             ← full capability matrix
│   ├── persistence-keys.md         ← localStorage / server prefs catalog
│   ├── error-boundaries.md         ← boundary placements + error reporting
│   ├── architecture-tests.md       ← catalog of every architecture gate
│   ├── editor-history.md           ← patch-based undo/redo history
│   ├── react-compiler.md           ← memoization rule, three exceptions, gates
│   └── use-async-resource.md       ← canonical async load hook; when to use vs. not
│
├── deployment/                 ← operator docs (running the thing)
└── e2e/                        ← browser test protocols (agent-run + Playwright automation)
```

Three categories, three voices:

- **Top-level docs** are long-lived references that describe the system as it currently is.
- **Feature docs** describe one first-class capability — its architecture, lifecycle, file layout.
- **Reference docs** are short, focused cookbooks for primitives and patterns reused across features.

---

## Where to look first

### "I want to understand the system"

1. [`architecture.md`](architecture.md) — the 10-minute orientation. Process layout, layer responsibilities, request lifecycle, publishing pipeline, plugin sandbox, where everything lives.
2. [`design.md`](design.md) — what the editor looks like and why. Tokens, surface system, UI primitives.
3. [`server.md`](server.md) and [`editor.md`](editor.md) — the two deep dives. Pick whichever side you're touching.

### "I want to add a feature"

1. Skim [`architecture.md`](architecture.md) → "Where things live — decision table".
2. Read the feature doc closest to what you're adding (e.g. [`features/plugin-system.md`](features/plugin-system.md) for a plugin SDK extension).
3. Read the relevant reference doc(s) for the primitives you'll touch ([`reference/page-tree.md`](reference/page-tree.md), [`reference/database-dialects.md`](reference/database-dialects.md), [`reference/typebox-patterns.md`](reference/typebox-patterns.md)).
4. Make the change. Verify with `bun test && bun run build && bun run lint`.

### "I want to change the visual design"

1. [`design.md`](design.md) — the principles, tokens, surface systems.
2. `src/styles/globals.css` — the actual tokens.
3. `src/ui/components/` — the actual primitives.
4. If you're adding a new token or surface pattern, update `design.md` in the same change.

### "I want to add a new HTTP endpoint"

1. [`server.md`](server.md) → "Adding a new endpoint".
2. [`reference/typebox-patterns.md`](reference/typebox-patterns.md) for body validation.
3. [`reference/database-dialects.md`](reference/database-dialects.md) if persistence is involved.

### "I want to mutate the page tree"

1. [`reference/page-tree.md`](reference/page-tree.md) — the `NodeTree` primitive and `mutateActiveTree`.
2. [`editor.md`](editor.md) → "Editor store" for how mutations are wired up.

### "I want to write a plugin"

1. [`features/plugin-system.md`](features/plugin-system.md) — the SDK surface, lifecycle, sandbox rules.
2. `examples/plugins/template/` — working example.
3. `src/core/plugin-sdk/capabilities.ts` — permission catalog (source of truth).

### "I want to deploy / operate the CMS"

1. `README.md` (repo root) — install, run, basic commands.
2. [`deployment/README.md`](deployment/README.md) — platform and generic deployment targets.
3. [`deployment/backup-restore.md`](deployment/backup-restore.md) — backing up production data.

---

## Doc index

### Top-level

| Doc                         | What it covers                                                          |
|-----------------------------|-------------------------------------------------------------------------|
| [architecture.md](architecture.md) | System overview: process, folders, request lifecycle, data model, validation, decision tables |
| [design.md](design.md)      | Visual design system: principles, tokens, surface systems, UI primitives, forbidden patterns |
| [server.md](server.md)      | Server deep dive: boot sequence, router, handlers, auth, DB adapter, publishing, plugin runtime |
| [editor.md](editor.md)      | Admin + editor deep dive: routing, workspaces, editor store, canvas, sidebars, spotlight |
| [CONVENTIONS.md](CONVENTIONS.md) | How docs in this repo are structured and written (read before authoring) |

### Features

| Doc                                                              | What it covers                                                       |
|------------------------------------------------------------------|----------------------------------------------------------------------|
| [features/plugin-system.md](features/plugin-system.md)           | The plugin system end-to-end: package shape, lifecycle, sandbox, SDK, permissions, CLI |
| [features/publisher.md](features/publisher.md)                   | The page-tree-to-HTML/CSS renderer + server-side publishing wrappers |
| [features/visual-components.md](features/visual-components.md)   | VCs, slots, params, instantiation, recursion guard                   |
| [features/content-storage.md](features/content-storage.md)       | `data_tables` + `data_rows` — the universal content store           |
| [features/content-workspace.md](features/content-workspace.md)   | Content workspace UI: collections, entries, body editor, settings panel |
| [features/data-workspace.md](features/data-workspace.md)         | Data workspace UI: DataInspector, field management, DataGrid        |
| [features/auth-and-access.md](features/auth-and-access.md)       | Sessions, MFA, step-up, lockout, CSRF, capabilities                  |
| [features/site-shell.md](features/site-shell.md)                 | The persisted site config (breakpoints, classes, files, deps)        |
| [features/modules.md](features/modules.md)                       | Module engine, defining first-party blocks                          |
| [features/dashboard.md](features/dashboard.md)                   | Dashboard workspace, widgets, grid, customize mode                  |
| [features/spotlight.md](features/spotlight.md)                   | Cmd+K command palette                                                |
| [features/agent.md](features/agent.md)                           | AI agent integration and provider-agnostic runtime                   |
| [features/mcp-connectors.md](features/mcp-connectors.md)         | Instatic as an MCP server — external AI clients drive the CMS over MCP |
| [features/templates.md](features/templates.md)                   | Entry templates + dynamic bindings + token interpolation             |
| [features/loops.md](features/loops.md)                           | `base.loop` + loop entity sources                                    |
| [features/cms-native-forms.md](features/cms-native-forms.md)     | Visual form primitives, presets, secure public submissions           |
| [features/media.md](features/media.md)                           | Media workspace, upload pipeline, storage adapters                  |
| [features/audit-log.md](features/audit-log.md)                   | Audit event catalog + recording new actions                         |
| [features/site-transfer.md](features/site-transfer.md)           | Export / import CMS bundle (JSON round-trip between instances)      |
| [features/site-import.md](features/site-import.md)               | Super Import — static-site files / ZIP → pages, style rules, media |
| [features/html-import.md](features/html-import.md)               | HTML string → `PageNode` fragment (paste HTML, AI `insertHtml` tool) |
| [features/editor-preferences.md](features/editor-preferences.md) | Catalog-driven local UI preferences for the editor                   |
| [features/canvas-iframe-per-frame.md](features/canvas-iframe-per-frame.md) | Per-breakpoint iframe rendering in the visual editor canvas |

### Reference

| Doc                                                              | What it answers                                                  |
|------------------------------------------------------------------|------------------------------------------------------------------|
| [reference/page-tree.md](reference/page-tree.md)                 | The `NodeTree<TNode>` primitive — mutations, store routing      |
| [reference/database-dialects.md](reference/database-dialects.md) | Postgres vs. SQLite — three rules + cookbook                    |
| [reference/typebox-patterns.md](reference/typebox-patterns.md)   | Validating every untyped boundary with TypeBox                  |
| [reference/ui-primitives.md](reference/ui-primitives.md)         | Full UI primitive catalog with "when to use"                    |
| [reference/design-tokens.md](reference/design-tokens.md)         | Complete CSS custom property catalog                            |
| [reference/module-engine.md](reference/module-engine.md)         | "How do I define a new module?"                                 |
| [reference/canvas-dnd.md](reference/canvas-dnd.md)               | Drag-and-drop / drop zones / insert location                    |
| [reference/admin-router.md](reference/admin-router.md)           | In-house router primitives                                      |
| [reference/css-class-registry.md](reference/css-class-registry.md) | User-defined CSS classes + scoped classes                     |
| [reference/capabilities.md](reference/capabilities.md)           | Full capability matrix + how to add one                         |
| [reference/persistence-keys.md](reference/persistence-keys.md)   | All localStorage / sessionStorage / server-prefs keys           |
| [reference/error-boundaries.md](reference/error-boundaries.md)   | `<ErrorBoundary>` placements + reporting                        |
| [reference/architecture-tests.md](reference/architecture-tests.md) | Catalog of every architecture gate test                       |
| [reference/editor-history.md](reference/editor-history.md)       | Patch-based undo/redo history: `HistoryEntry`, `mutate*` helpers, coalescing |
| [reference/react-compiler.md](reference/react-compiler.md)       | React Compiler memoization rule, three exceptions, enforcement gates |
| [reference/use-async-resource.md](reference/use-async-resource.md) | `useAsyncResource` — canonical single-resource async load hook; when to use and when not to |

### Operations

| Folder                              | Contents                                                          |
|-------------------------------------|-------------------------------------------------------------------|
| [deployment/](deployment/)          | Platform deploys, VPS/Docker installs, TLS, backup, releases      |
| [e2e/](e2e/)                        | Browser E2E protocols: agent-run audits and Playwright automation docs |

---

## Conventions in one paragraph

Every doc has the shape: **one-line scope statement → TL;DR → body sections → Related**. Every claim about code anchors to a real file path. Every invariant links to the gate test (in `src/__tests__/architecture/`) that enforces it. No history, no aspiration, no marketing copy — describe what the system is, not what it could be or what it used to be. If a doc is over ~600 lines, it's doing too much; split it. The full rules are in [CONVENTIONS.md](CONVENTIONS.md).

---

## Source-of-truth pointers

Quick map from "where do I look for X?" to the canonical file:

| Concept                          | Source of truth                                          |
|----------------------------------|----------------------------------------------------------|
| Agent rules and constraints      | `CLAUDE.md` (repo root)                                  |
| Design tokens                    | `src/styles/globals.css`                                 |
| UI primitives                    | `src/ui/components/`                                     |
| Page tree shape                  | `src/core/page-tree/treeSchema.ts`                       |
| Editor store                     | `src/admin/pages/site/store/`                            |
| Server router                    | `server/router.ts`                                       |
| CMS API handlers                 | `server/handlers/cms/`                                   |
| Repositories                     | `server/repositories/`                                   |
| DB adapter interface             | `server/db/client.ts`                                    |
| DB adapters                      | `server/db/postgres.ts`, `server/db/sqlite.ts`            |
| Migrations                       | `server/db/migrations-pg.ts`, `server/db/migrations-sqlite.ts` |
| Plugin SDK                       | `src/core/plugin-sdk/`                                   |
| Plugin permission catalog        | `src/core/plugin-sdk/capabilities.ts`                    |
| Plugin manifest parser           | `src/core/plugins/manifest.ts`                           |
| Plugin sandbox host              | `server/plugins/quickjs/vm.ts`, `server/plugins/modulePackVm.ts` |
| Publisher                        | `src/core/publisher/`                                    |
| CSS value sanitiser              | `src/core/css-sanitize/sanitiseCssValue.ts`              |
| TypeBox helpers                  | `src/core/utils/typeboxHelpers.ts`                       |
| Error message extraction         | `src/core/utils/errorMessage.ts`                         |
| Architecture gate tests          | `src/__tests__/architecture/*.test.ts`                   |
