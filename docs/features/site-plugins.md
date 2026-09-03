# Site plugins

**TL;DR** — Site plugins are full backend/frontend plugins authored inside the
site draft (`plugins/<local-id>/`, `SiteFile` entries with `type: 'plugin'`),
developed in a full-screen **Plugin IDE** with live multi-author co-editing,
compiled server-side into packages **byte-compatible with installed plugins**
(`uploads/plugins/site.<local-id>/<version>/`), and activated through the
exact same install/upgrade lifecycle, sandbox, permissions, settings, and
crash handling. The runtime never branches on provenance.

This document is the design of record; the original spec and implementation
plan were working notes and are not kept in the repository.

## The user-facing model

Two concepts, deliberately:

- **Frontend scripts** — the relabeled Scripts section of the site editor:
  standalone page JavaScript with no backend counterpart.
- **Plugins** — units of code with powers, requiring operator approval. Some
  are **installed** (uploaded zips), some are **site plugins** (authored in
  this site's draft). Both share the permission review, settings surface,
  lifecycle states, logs, and crash handling.

If browser code talks to a plugin's server code, it lives in that plugin's
`frontend/` assets — the placement rule is surfaced in both UIs.

## Where the code lives

| Piece | Path |
| --- | --- |
| Source model (discovery, derivation, hash, templates, states) | `src/core/site-plugins/` |
| Shared package builder (CLI + server) | `src/core/plugin-build/` |
| Import containment resolver | `src/core/plugin-build/containment.ts` |
| Server build orchestrator (workspace, single-flight, timeout) | `server/plugins/sitePlugins/build.ts` |
| Workspace materializer | `server/plugins/sitePlugins/workspace.ts` |
| Revision retention / rollback target | `server/plugins/sitePlugins/retention.ts` |
| HTTP routes + service layer (list, activation engine) | `server/handlers/cms/sitePlugins/` |
| Disk-package activation seam (shared with zip installs) | `server/handlers/cms/plugins/install.ts` → `activatePluginPackageFromDisk` |
| Plugin IDE | `src/admin/pages/plugins/ide/` |
| Plugins-page integration (merged list, draft cards, scaffold dialog) | `src/admin/pages/plugins/PluginsPage.tsx`, `components/DraftSitePluginCard.tsx`, `components/NewSitePluginDialog.tsx` |
| Draft canvas preview (editor side) | `src/admin/pages/site/hooks/useDraftModulePackPreview.ts` |
| Collab CodeMirror binding | `src/admin/pages/site/code-editor/CollabCodeMirrorEditor.tsx` |
| Granular collab files (Y.Map + Y.Text content) | `src/core/collab/filesY.ts` |
| SDK route helper | `src/core/plugin-sdk/sitePluginRoute.ts` |
| AI plugin scope (tools, prompt, snapshot) | `server/ai/tools/plugin/`, `src/admin/pages/plugins/ide/agent/` |

## Source layout and field ownership

Source lives under `plugins/<local-id>/` (`<local-id>` = one lowercase
kebab-case segment; runtime id `site.<local-id>`). The draft `plugin.json`
carries **author intent only** — the build derives the rest and REJECTS
author-set derived fields (`additionalProperties: false` against
`SitePluginDraftManifestSchema`, whose field shapes are the runtime
manifest's own sub-schemas — `MANIFEST_AUTHOR_FIELD_SCHEMAS`).

| Author writes | Builder derives |
| --- | --- |
| `name`, `description`, marketplace metadata | `id` (= `site.<local-id>`) |
| `permissions` | `version` (= `1.0.<buildCounter>+<contentHash>`) |
| `contentAccess[]`, `settings[]` | `apiVersion` (= host `PLUGIN_API_VERSION`) |
| `resources[]`, `adminPages[]` | `entrypoints` (folder convention: `server/index.ts`, `editor/index.ts`, `modules/*`) |
| `frontend.assets[]` (source paths, rewritten to built `.js`) | `assetBasePath` (pinned `/uploads/plugins/{id}/{version}`) |
| `networkAllowedHosts[]` | `pack` (from `pack/site.json` presence) |

The generated version passes the manifest `SEMVERISH_PATTERN`, is monotonic
(ordered `migrate({ fromVersion })`), and carries the source fingerprint —
`contentHashOfVersion` powers the skip-rebuild and the `Draft changed` state.

## Build pipeline

`buildSitePlugin` (server): flush the collab relay (`runPublishFlush` — the
IDE persists continuously through the relay), read the persisted draft,
derive the manifest, materialize a temp workspace, and run the shared
`buildPluginPackage` with a **fail-closed `ImportResolverPolicy`**:

- imports originating in the workspace must resolve inside it — upward
  escapes, absolute paths, and import-attribute payloads
  (`with { type: 'text' }`) fail the build (without this, draft code could
  embed `.env`/DB files into a bundle and exfiltrate them through the
  plugin's own routes — the sandbox literal scan does not cover this class);
- **build-time macros are refused before Bun parses the file.** Bun runs
  `import x from './m.ts' with { type: 'macro' }` inside the host process at
  bundle time, with full Node/Bun access; the macro module resolves inside
  the workspace, so path containment cannot catch it, and the sandbox scan
  runs on the output after the macro already executed. The containment
  plugin's `onLoad` hook (`assertNoBuildTimeMacros`) scans every workspace
  source textually and fails closed: only `{ type: 'json' | 'text' | 'file'
  | 'toml' }` attribute clauses are allowed, anything else (a macro, a
  comment inside the clause, an escaped key) is a build error;
- exactly one bare specifier is mapped: `@instatic/plugin-sdk` → the host
  SDK entry (pure data builders inline into sandbox bundles);
- editor/admin bundles keep the host-runtime externals (import-map
  resolved).

Builds are single-flight per plugin with a 30 s timeout, and every
lifecycle transition (activate, rollback, delete) is serialized per plugin
id on top of that (`withSitePluginLock` in the service layer) — two
overlapping activations would otherwise both read the same row version,
derive the same next counter, and race the upgrade path. The diagnostics
strip, the preview-pack route and the AI `plugin_validate` tool all run the
same `buildDraftSitePlugin` (service layer). Diagnostics carry the author's
file, line and column (`plugins/<id>/modules/foo.ts:22:16: …`); the modules
pack's generated facade never appears in them. Validate-only mode
writes into the throwaway workspace (never uploads), returns diagnostics,
and can return the built modules bundle text (the preview-pack route).
Diagnostics are bundle/parse errors, sandbox-scan violations, containment
violations, and manifest errors — **not** TypeScript semantic errors
(`Bun.build` does not typecheck; the UI must not promise it).

## Runtime model and lifecycle

A site plugin IS an `installed_plugins` row (`source: 'site-local'`,
migration `022_installed_plugins_source`, additive, both dialects). The
worker, QuickJS VM, route registry, hooks, schedules, settings/secrets,
event broadcaster, crash recovery, and frontend injection consume it with
**zero provenance branches** (gated by `site-plugin-invariants.test.ts`).

Activation rides `activatePluginPackageFromDisk` — the same seam the zip
route uses: fresh = `install` → `activate`; version change = old
`deactivate` → row swap → `migrate({ fromVersion })` → `activate` with
rollback on failure. Settings and encrypted secrets survive rebuilds
(insert-if-absent seeding) — a contract, not an accident. Declared packs
auto-sync on activation like installed plugins.

### Authority

- **Authoring** (IDE editing, scaffold) — `plugins.edit`, its own
  capability: the scaffold endpoint requires it, and the relay write
  policy's `plugins` category gates every live edit to a `type: 'plugin'`
  file (add/rename/delete/content — even full site-writers need it).
  Never `plugins.install`, never a `site.*` capability.
- **Validation / preview** — no elevated capability (`site.read`).
- **`Build & activate` / rollback / delete** — `plugins.install`; step-up
  ONLY on the consent moments: first activation, grant-set changes, and
  rollbacks that change the grant set. Same-grant rebuilds skip both the
  review and the step-up — the security boundary is the grant set, not the
  code revision.
- Grants = declared, in both directions: activation grants exactly what the
  draft declares; dropping a permission shrinks the grant.
- The `site.*` id namespace is **reserved**: the zip boundary
  (`readPluginPackage`) rejects uploaded packages claiming it.

### Runtime states

Computed by `computeSitePluginState` (shared server + UI vocabulary) over
the **union** of draft folders and site-local rows — deleting the folder
never hides a running backend (`Source missing` still lists, offering
deactivate/delete):

`active` · `draft-changed` · `build-failed` · `permission-review` ·
`runtime-error` · `disabled` · `source-missing`

Each state maps to ONE smart primary action (`sitePluginPrimaryAction`),
rendered in the IDE header; the Plugins-page draft card only offers `Open
IDE` (an activated site plugin is an ordinary installed row there).
Unavailable actions are disabled with an inline reason, never hidden.

## The Plugin IDE

`/admin/plugins/develop/<local-id>` — a full-screen workspace-canvas route
(`AdminWorkspace: 'pluginIde'`, layout persistence like every canvas):
file tree (left, resizable) and the co-edited CodeMirror buffer with the
diagnostics strip beneath it. There is deliberately no right panel:
`plugin.json` is edited as raw JSON in the buffer (auto-selected on open),
and every manifest mistake surfaces as a named diagnostic.

**Live multi-author co-editing**: the shell's `files` key is a granular
Y.Map — one entry per file id, `content` as Y.Text (`@core/collab/filesY.ts`).
The IDE binds ONLY `site:default` over the site socket (its own
`CollabProvider`; server-seeded docs), so:

- two admins co-type one file character-level, with per-peer colored carets
  (y-codemirror.next);
- file CRUD and renames merge per-field;
- the shell's `files` value is granular for every consumer of the site doc
  (the site editor's Scripts panel still writes whole strings at the store
  layer, so it is the IDE that co-edits character-level);
- presence is shared: site editors see IDE users in their roster; IDE rows
  show who's editing which file;
- undo is per-file and local-only: the co-edited buffer mounts WITHOUT
  CodeMirror's own `history()` (which would record peers' deltas as
  undoable steps) and the Y.UndoManager keymap takes precedence over every
  other Mod-z binding.

Two lifecycle rules keep the session safe:

- **nothing writes before the first sync.** An unsynced doc has no `files`
  map; creating one client-side would win the merge (the server seeds with
  client id 1) and replace every site file with the one just created. Every
  mutating session method throws `IdeNotSyncedError` until `synced()` is
  true, the file tree keeps New file / rename / delete disabled with the
  reason, and the agent bridge answers "still connecting";
- **a relay reset rebinds.** `FRAME_RESET` (an out-of-relay shell write —
  scaffold, delete, settings save, import — reseeded the doc) destroys the
  bound Y.Doc. The session rebinds at once, bumps its `generation`, drops
  the undo managers that referenced the dead Y.Text, and the buffer
  remounts keyed on the generation instead of typing into a destroyed type.

There is no save button — the relay persists continuously; Cmd+S re-runs
diagnostics. Automatic validation runs debounced on every change.

### The AI panel (`plugin` chat scope)

The left rail's AI button (gated by `ai.chat`) docks the shared AgentPanel
— the same chat Site and Content have, on the `plugin` tool scope
(`server/ai/tools/plugin/`):

- **File tools are browser-bridged** to the live CRDT session: the agent
  reads exactly what you see (un-persisted keystrokes included) and its
  edits merge character-level with concurrent typing.
  `plugin_read_file` paginates + hashes; `plugin_patch_file` requires the
  latest hash (stale edits fail instead of clobbering); write/rename/
  delete gate on `plugins.edit`; `plugin_open_file` moves the visible
  buffer.
- **`plugin_docs`** serves the curated author reference (manifest,
  admin-pages, server, modules, editor, frontend, workflow, examples) so
  the agent reads contracts instead of guessing them from build errors.
  Content lives in `server/ai/tools/plugin/docs.ts` and must track the SDK
  contracts it documents.
- **Lifecycle tools are server-resolved**: `plugin_list_plugins`,
  `plugin_validate` (the diagnostics-strip build), and `plugin_activate` —
  same-grant rebuilds only. A changed grant set is refused with an
  instruction to confirm in the IDE header: the permission review +
  step-up stays a human consent moment.
- The IDE registers its tool bridge for the whole page mount
  (`usePluginIdeToolBridge`), so **external MCP connectors** reach the
  open IDE with the panel closed — full parity with Site/Content
  (docs/features/mcp-connectors.md). Lifecycle tools also run headless
  over MCP.

The per-request snapshot (open plugin, file list, active buffer, runtime
state, latest diagnostics) rides every send; the `plugin` scope has its own
default model row on /admin/ai/defaults.

`plugin.json` has no structured editor — the raw buffer is the manifest
surface. Manifest coherence (e.g. an `editor/` entry file without
`editor.code` declared) is enforced by validation, and the human-readable
permission treatment lives where it matters: the activation review dialog.

## Publish coupling, retention, preview

- Activating a revision with visitor-facing surfaces (frontend assets or a
  module pack) **republishes before sweeping** — baked Layer-A HTML embeds
  versioned asset URLs and must never reference a deleted revision. Both
  artefact kinds are re-baked in place under the publish lock: pages
  (`republishAllPages`) and entry-template data rows such as `/posts/hello`
  (`republishAllDataRows`), stamped with the version that becomes current
  at the bump that follows. Backend-only plugins skip the republish.
- Retention keeps the five highest builds plus the active one
  (`RETAINED_REVISIONS` in `server/plugins/sitePlugins/retention.ts`); the
  sweep runs after activation and the coupled republish succeed. Every
  retained build is a rollback target: the summary lists them
  (`revisions`, newest first, with the build time), the IDE's `Roll back
  to…` submenu offers them, and `POST …/rollback { version }` re-activates
  one — the version is validated against the retained directories, never
  joined into a path unchecked, and a target with a different grant set
  steps up like any grant change. Source rolls forward only, so the
  artifact is the only rollback; after one the draft reads `Draft changed`
  and `Build & activate` redeploys the newest code. Uninstall sweeps the
  whole `uploads/plugins/site.<id>/` tree via the existing teardown.
- `Preview in canvas` (module drafts): the IDE opens
  `/admin/site?previewSitePlugin=<local-id>`; the editor fetches the
  validate-only bundle from `GET .../preview-pack.js` (no-store), activates
  it browser-side into the requesting session only, and badges the modules
  `Draft` in the inserter. Nothing registers server-side. Publishing a page
  that uses a `site.*` module with no active registration logs a publish
  warning naming the plugin (renderNode).

## Export / import

The site bundle carries plugin SOURCE (`type: 'plugin'` shell files) —
never generated artifacts, secrets, or runtime rows. On import the source
lands as draft; the operator rebuilds and activates on the target so
grants, secrets, and network allowlists are reviewed in that environment.

## Frontend → backend calls

```ts
import { sitePluginRoute } from '@instatic/plugin-sdk'
await fetch(sitePluginRoute('newsletter', '/subscribe'), { method: 'POST' })
// → /admin/api/cms/plugins/site.newsletter/runtime/subscribe
```

Pure string helper: frontend bundles inline it (published pages have no
import map); editor/admin bundles resolve it through the host import map.

## Forbidden patterns

- Author-set derived fields in a draft `plugin.json` (fails the build).
- `site.*` ids in uploaded zip packages (rejected at the zip boundary).
- `type === 'plugin'` matches in any published-output pipeline (gated).
- Provenance branches in runtime machinery (gated).
- Calling `buildPluginPackage` server-side without the containment policy
  (gated).
- `with { type: 'macro' }` (or any non-inert import attribute) in draft
  source — refused before Bun parses the file (gated).
- Writing to the IDE session before `synced()` is true.

## Gate tests

- `src/__tests__/architecture/site-plugin-invariants.test.ts`
- `src/__tests__/architecture/site-plugin-file-isolation.test.ts`
- `src/__tests__/server/pluginPackageNamespace.test.ts`
- `src/__tests__/server/pluginSourceColumn.test.ts`
- `src/__tests__/plugins/pluginBuildContainment.test.ts`
- `src/__tests__/server/sitePluginBuild.test.ts`
- `src/__tests__/server/sitePluginLifecycle.test.ts`
- `src/__tests__/server/sitePluginRetention.test.ts`
- `src/__tests__/server/sitePluginPreviewPack.test.ts`
- `src/__tests__/server/sitePluginExport.test.ts`
- `src/__tests__/sitePlugins/*` (source model, route helper)
- `src/__tests__/collab/filesGranular.test.ts` (co-editing granularity)
