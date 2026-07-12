/**
 * Plugin-scope documentation tool — `plugin_docs`.
 *
 * The system prompt carries only a summary; this tool is the authoritative
 * on-demand reference so the agent reads the REAL contract before writing
 * code instead of discovering it through build/runtime errors. Content is
 * curated by hand from the SDK types and host loaders it documents
 * (`src/core/plugin-sdk/types/*`, `src/core/plugins/adminRuntime.ts`,
 * `src/core/site-plugins/templates.ts`) — when those contracts change,
 * update the matching topic here in the same change.
 *
 * Deliberately embedded strings (not repo-file reads): they version with
 * the build, exist on every install, and stay author-facing rather than
 * contributor-facing.
 */
import { Type } from '@core/utils/typeboxHelpers'
import { aiToolError, aiToolOk } from '@core/ai'
import type { AiTool } from '../types'

const TOPICS: Record<string, { summary: string; content: string }> = {
  manifest: {
    summary: 'plugin.json fields, permissions list, derived fields, coherence rules',
    content: `# plugin.json (site plugin draft manifest)

Author-owned fields — everything else is DERIVED by the build and must NOT be set
(id, version, apiVersion, entrypoints, assetBasePath, pack, grantedPermissions, icon):

{
  "name": "…",                      // required
  "description": "…",
  "permissions": ["…"],             // see list below
  "networkAllowedHosts": ["api.example.com"],  // required with network.outbound
  "resources": [ … ],               // plugin-owned record types (see admin-pages topic)
  "adminPages": [ … ],              // admin navigation pages (see admin-pages topic)
  "settings": [ … ]                 // operator-editable settings (text/textarea/number/select/toggle variants)
}

Entrypoints derive from folders: server/index.ts → sandboxed backend;
editor/index.ts → unsandboxed admin code (requires "editor.code");
modules/*.ts → canvas module pack (requires "modules.register");
frontend/* → built/published assets.

Permissions (exact ids):
- admin.navigation — adminPages appear in the admin nav
- cms.storage — records via api.cms.storage.collection()
- cms.routes — register backend HTTP routes; cms.routes.public additionally allows anonymous routes
- cms.hooks — subscribe to host events
- cms.content.read / cms.content.write / cms.content.publish / cms.content.delete —
  the host's content tables via api.cms.content.*; ALSO requires the manifest to
  list target tables in "contentAccess": [{ "table": "posts", "modes": ["read"] }]
- cms.content.tables.manage — create user tables (dangerous)
- editor.code — plugin JS loaded into the admin window (required by editor/ entry AND kind:'app' admin pages)
- editor.toolbar / editor.commands / editor.canvas / editor.panels /
  editor.store.read / editor.store.write — specific editor API surfaces
- modules.register / loops.register / visualComponents.register / dashboard.widgets.register
- media.storage.adapter / media.url.transform / media.variant.delegate
- frontend.assets — inject declared tags into published pages (manifest "frontend": { "assets": [...] })
- network.outbound — fetch() from the sandbox, only to networkAllowedHosts
- cms.schedule — scheduled jobs via api.cms.schedule

Coherence is enforced at build: an entry file whose permission is missing fails
validation with a named diagnostic. Grants = declared: activation grants exactly
the manifest's permission list (changes need human consent in the IDE header).`,
  },
  'admin-pages': {
    summary: 'adminPages content kinds — markdown, resource CRUD, map, app (React)',
    content: `# Admin pages

"adminPages": [{ "id": "kebab-id", "title": "…", "navLabel": "…", "content": … }]
Requires the "admin.navigation" permission. content is a strict union:

1. Markdown (static, no code):
   { "kind": "markdown", "body": "…markdown…", "heading": "optional" }

2. Resource CRUD page — THE way to build "manage records" pages (customers,
   leads, bookings). The HOST renders the full list/create/delete UI; records
   live in plugin storage; zero custom code:
   { "kind": "resource", "heading": "Customers", "resource": "customers" }
   plus a matching top-level declaration:
   "resources": [{
     "slug": "customers",
     "labelField": "name",
     "fields": [
       { "id": "name", "label": "Name", "type": "text", "required": true },
       { "id": "email", "label": "Email", "type": "text" },
       { "id": "active", "label": "Active", "type": "boolean" }
     ]
   }]
   Server code reads/writes the same records: api.cms.storage.collection('customers')
   (requires "cms.storage" for server access; the page itself needs no extra code).

3. Map page: { "kind": "map", "heading": "…", "pins": [{ "label", "x", "y" }] }

4. App page — custom React UI (heavyweight; needs "editor.code"):
   { "kind": "app", "heading": "…", "entry": "frontend/customers.js" }
   - entry MUST be a JS module bundled from a TOP-LEVEL frontend/ source
     (frontend/customers.tsx → frontend/customers.js; the build rewrites and
     verifies this — .html files are NOT valid entries).
   - The module's DEFAULT EXPORT must be a React component. The host
     dynamically import()s it; react / react-dom / @instatic/host-hooks are
     provided via import map (leave them as plain imports).
   - Read plugin context with hooks from '@instatic/host-hooks':
     usePluginContext() → { pluginId, settings, grantedPermissions, routes, … }
     ctx.routes.fetch(path) / ctx.routes.json(path, schema?) call this plugin's
     own runtime routes with credentials.
   Prefer kind:'resource' whenever the page is fundamentally a record table.`,
  },
  server: {
    summary: 'server/index.ts — hooks, routes, storage, settings, content, schedule',
    content: `# Server entrypoint (server/index.ts — QuickJS sandbox)

Default-export lifecycle hooks; each receives api: ServerPluginApi:

import type { ServerPluginModule } from '@instatic/plugin-sdk'
const mod: ServerPluginModule = {
  activate(api) { … },       // every boot + after install/upgrade
  install(api) { … },        // once, first install
  deactivate(api) { … },
  uninstall(api) { … },
  migrate(ctx, api) { … },   // upgrades; ctx.fromVersion; make idempotent
}
export default mod

api.plugin: { id, version, permissions, log(...), assetUrl(path) }

api.cms.routes (permission "cms.routes") — paths mount under
/admin/api/cms/plugins/<pluginId>/runtime/<path>; browser code builds the URL
with sitePluginRoute('<localId>', '<path>') from '@instatic/plugin-sdk':
  api.cms.routes.get('/list', 'plugins.read', handler)      // capability-gated
  api.cms.routes.authenticated.post('/save', handler)       // any signed-in admin
  api.cms.routes.public.get('/webhook', handler)            // needs "cms.routes.public"
Handler: (ctx) => value — ctx = { req, body (pre-parsed JSON/form), user | null }.
Returned values are JSON-serialized (status 200); return
{ status, headers?, body } for raw responses.

api.cms.storage.collection('<resource-slug>') (permission "cms.storage"):
  .list({ …options }) / .create(data) / .update(id, data) / .delete(id)
  Records persist in the host DB — survive restarts. Declare the resource in
  the manifest "resources" array.

api.cms.settings — read/replace operator settings declared in the manifest.
api.cms.schedule (permission "cms.schedule") — cadence handlers (daily/hourly/every-minutes).
api.cms.hooks (permission "cms.hooks") — host event subscriptions.
api.cms.content (permissions "cms.content.*" + manifest contentAccess[]):
  .tables.list()/.get(slug); .table(slug).list/get/getBySlug/create/update/
  delete/publish/createMany/updateMany/deleteMany;
  .tree(entryId, fieldId).read/mutate/replace (page-tree operations);
  .search(query); .getPublishedSnapshot(entryId); .republishAll()
api.cms.loops.registerSource — loop entity sources (id "<pluginId>.<name>").
api.cms.media — storage adapter / URL transformer / variant delegate registration.

Sandbox rules: no Node/Bun ambient APIs; fetch() only with "network.outbound" +
networkAllowedHosts; imports limited to your own files + '@instatic/plugin-sdk'.
NO persistent in-memory state across restarts — use storage collections.`,
  },
  modules: {
    summary: 'modules/*.ts — defineModule canvas blocks, controls, html helper',
    content: `# Canvas modules (modules/*.ts — permission "modules.register")

Each top-level modules/ file default-exports defineModule({...}):

import { control, defineModule, html } from '@instatic/plugin-sdk'
export default defineModule({
  id: 'site.<localId>.<name>',        // namespace-locked to the plugin id
  name: 'Display name',
  description: '…',
  category: 'Group label',            // module inserter section
  htmlTag: 'div',
  defaults: { message: 'Hello' },     // prop defaults
  schema: {                           // right-panel controls per prop
    message: control.text('Message'),
  },
  render: ({ props }) => ({
    html: html\`<div class="my-block">\${props.message}</div>\`,
    css: '.my-block { padding: 12px; }',
  }),
})

control builders: text, textarea, number, color, select(label, options),
toggle, image, url.
html\`…\` escapes interpolations by default; raw(str) opts out; escapeHtml /
safeUrl available. render runs in the publisher sandbox AND the editor
canvas preview — keep it pure (props in, { html, css } out).
The editor previews DRAFT modules live (no activation needed): use the
preview action in the IDE header.`,
  },
  editor: {
    summary: 'editor/index.ts — unsandboxed admin extension: commands, toolbar, panels, store',
    content: `# Editor extension (editor/index.ts — permission "editor.code")

Runs UNSANDBOXED in the admin window (that's why activation shows a red
consent warning). Export an activate function:

export function activate(api) {
  api.editor.commands.register({          // permission "editor.commands"
    id: 'site.<localId>.my-command',
    label: 'My command',
    run: () => { … },
  })
}

api.editor surfaces (each gated by its own permission):
- commands.register — command palette + programmatic runs ("editor.commands")
- toolbar.register — toolbar buttons ("editor.toolbar")
- palette.register — palette-only commands with subtitles ("editor.commands")
- panels.register — custom editor panels; panel id must start with the plugin id ("editor.panels")
- store.read(fn) / store.transaction(mutate) — read or mutate the live editor
  store ("editor.store.read" / "editor.store.write"); transactions ride the
  host's undo + collab machinery
Canvas overlays: "editor.canvas".

Keep editor code minimal — it ships to every admin's browser on every load.`,
  },
  frontend: {
    summary: 'frontend/ assets — bundling rules, published-page injection, admin app entries',
    content: `# Frontend assets (frontend/)

Bundling: every TOP-LEVEL frontend/<name>.(ts|tsx|js|mjs) becomes
frontend/<name>.js in the package. Nested folders (frontend/utils/…) are
helpers only — imported into top-level entries, not bundled separately.
CSS files are copied as-is.

Two consumers:
1. Published pages — declare tags in the manifest (permission "frontend.assets"):
   "frontend": { "assets": [
     { "kind": "script", "src": "frontend/widget.ts", "placement": "body-end" },
     { "kind": "style", "src": "frontend/widget.css" }
   ] }
   The build rewrites .ts→.js. The host injects the tags into every published
   page and adjusts CSP. Use api.plugin.assetUrl(path) server-side for URLs.
2. Admin app pages — adminPages kind:'app' entries point at a built
   frontend/<name>.js whose default export is a React component (see the
   admin-pages topic). react / @instatic/host-hooks resolve via import map —
   import them normally, they are NOT bundled.

Browser → backend: call your own routes with
sitePluginRoute('<localId>', '/path') from '@instatic/plugin-sdk'
(equals /admin/api/cms/plugins/site.<localId>/runtime/path).`,
  },
  workflow: {
    summary: 'validate → activate lifecycle, states, consent, publish coupling, rollback',
    content: `# Build & activation workflow

1. Edit files (live CRDT — no save step). plugin_validate runs the REAL build:
   bundling, import containment, manifest coherence. Iterate until clean.
2. plugin_activate builds a new revision (version 1.0.<n>+<contentHash>) and
   runs the install/upgrade lifecycle. Same-grant rebuilds run without
   friction; a CHANGED permission set (including first activation) is a human
   consent moment — ask the user to click "Build & activate" in the IDE header.
3. Visitor-facing surfaces (modules pack, frontend assets) trigger an
   automatic republish of baked pages on activation.

States: active · draft-changed (source differs from active revision) ·
build-failed · permission-review (grants differ) · runtime-error · disabled ·
source-missing. plugin_list_plugins reports them.

Settings + secrets survive rebuilds. Rollback re-activates the retained
previous revision (IDE header menu). Deleting the plugin removes the runtime
row AND the draft folder.

Gotchas:
- diagnostics are build/containment/manifest errors, NOT TypeScript type checks;
- in-memory server state resets on restarts/rebuilds — persist via storage;
- a patch hash mismatch means the file changed (user typing) — re-read, retry.`,
  },
  examples: {
    summary: 'complete minimal examples: routes backend, canvas module, resource CRUD page',
    content: `# Examples

## Backend route + browser fetch
plugin.json: { "name": "Status", "permissions": ["cms.routes"] }
server/index.ts:
  import type { ServerPluginModule } from '@instatic/plugin-sdk'
  const mod: ServerPluginModule = {
    activate(api) {
      api.cms.routes.get('/status', 'plugins.read', () => ({
        ok: true, version: api.plugin.version,
      }))
    },
  }
  export default mod
Browser side: fetch(sitePluginRoute('<localId>', '/status'), { credentials: 'same-origin' })

## Canvas module
plugin.json: { "name": "Notice", "permissions": ["modules.register"] }
modules/notice.ts:
  import { control, defineModule, html } from '@instatic/plugin-sdk'
  export default defineModule({
    id: 'site.<localId>.notice',
    name: 'Notice', description: 'Callout box', category: 'Notice',
    htmlTag: 'div',
    defaults: { message: 'Heads up!' },
    schema: { message: control.text('Message') },
    render: ({ props }) => ({
      html: html\`<div class="notice">\${props.message}</div>\`,
      css: '.notice { padding: 12px; border-radius: 6px; }',
    }),
  })

## Customers CRUD page (records managed from the admin nav — NO custom code)
plugin.json:
  {
    "name": "Customers",
    "permissions": ["admin.navigation", "cms.storage"],
    "resources": [{
      "slug": "customers",
      "labelField": "name",
      "fields": [
        { "id": "name", "label": "Name", "type": "text", "required": true },
        { "id": "email", "label": "Email", "type": "text" },
        { "id": "active", "label": "Active", "type": "boolean" }
      ]
    }],
    "adminPages": [{
      "id": "customers",
      "title": "Customers",
      "navLabel": "Customers",
      "content": { "kind": "resource", "heading": "Customers", "resource": "customers" }
    }]
  }
(cms.storage lets optional server code read the same records:
api.cms.storage.collection('customers').list())`,
  },
}

const TOPIC_IDS = Object.keys(TOPICS).sort()

const DocsInputSchema = Type.Object({
  topic: Type.Optional(Type.String({ minLength: 1 })),
})

export const pluginDocsTool: AiTool = {
  name: 'plugin_docs',
  scope: 'plugin',
  execution: 'server',
  description:
    `Authoritative plugin-development reference. Call WITHOUT topic for the index; with topic for the full contract. Topics: ${TOPIC_IDS.join(', ')}. Read the matching topic BEFORE writing code in an area you have not touched in this conversation — it is cheaper than discovering contracts through build errors.`,
  inputSchema: DocsInputSchema,
  handler: async (input) => {
    const { topic } = input as { topic?: string }
    if (!topic) {
      return aiToolOk({
        topics: TOPIC_IDS.map((id) => ({ topic: id, summary: TOPICS[id]!.summary })),
      })
    }
    const entry = TOPICS[topic]
    if (!entry) {
      return aiToolError(`Unknown docs topic "${topic}". Available: ${TOPIC_IDS.join(', ')}.`)
    }
    return aiToolOk({ topic, content: entry.content })
  },
}
