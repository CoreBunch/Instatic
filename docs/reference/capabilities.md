# Capabilities

The full catalog of `CoreCapability` strings, what each grants, which role gets them by default, and how to add a new capability.

For the broader auth flow (sessions, MFA, step-up), see [docs/features/auth-and-access.md](../features/auth-and-access.md). This page is the capability matrix and the "how do I add one?" cookbook.

---

## TL;DR

- Defined as a `const` array in `src/core/capabilities.ts` (`@core/capabilities`); `CoreCapability` is derived via `typeof CORE_CAPABILITIES[number]`. **40 capabilities.**
- Handlers gate on capability, not on role: `requireCapability(req, db, 'site.read')`.
- The **Owner AND Admin** roles get their capability lists force-resynced from `SYSTEM_ROLES` on every server boot. Hand-edits to either built-in role through the admin UI are restored at next boot — they are code-level decisions, not runtime ones.
- Adding a capability: append the literal to `CORE_CAPABILITIES` in `src/core/capabilities.ts` (one place — server imports it), add it to the relevant `SYSTEM_ROLES` entries, wire `requireCapability(...)` at the gate point, and add picker meta + groups for the role-edit dialog. The two architecture tests (`capability-picker-coverage.test.ts`, `cms-handlers-capability-gated.test.ts`) catch missing pieces.
- Custom roles editable in the Roles admin page (Owner-only `roles.manage`).

---

## The 40 core capabilities

### Read

| Capability         | Grants                                                              | Roles            |
|--------------------|---------------------------------------------------------------------|------------------|
| `dashboard.read`   | Open the Dashboard workspace                                        | Owner, Admin, Client |
| `site.read`        | Open the Site workspace; view pages, VCs, classes. Also gates `/runtime/preview` (preview HTML rendering of the posted draft). | Owner, Admin, Client |

### Site editing (three-way split)

| Capability               | Grants                                                              | Roles         |
|--------------------------|---------------------------------------------------------------------|---------------|
| `site.structure.edit`    | Add / remove / move / rename nodes; manage pages, VCs, classes      | Owner, Admin  |
| `site.content.edit`      | Modify content props (text, image src/alt, link href) on existing nodes — no structure or style edits | Owner, Admin, Client |
| `site.style.edit`        | Modify CSS classes, style overrides, breakpoints, framework tokens  | Owner, Admin  |

`SITE_WRITE_CAPABILITIES` is the convenience set `['site.structure.edit', 'site.content.edit', 'site.style.edit']` — defined locally in `server/handlers/cms/site.ts` and `src/admin/access.ts` at each point of use, not in a shared capabilities module. Used by the site shell save handler and the page-row save path. `/pages` accepts any site writer, then diff-validates each changed page by category: page roster, metadata, topology, module identity, non-content props, and dynamic bindings require `site.structure.edit`; content-category props require `site.content.edit`; inline styles/classes/breakpoint overrides require `site.style.edit`. `/components` and `/layouts` accept no-op saves from any site writer so the client can save one dirty family without tripping over empty batches, but actual changed components/layouts or roster removals still require `site.structure.edit`.

### Page publishing

| Capability       | Grants                                  | Roles         |
|------------------|-----------------------------------------|---------------|
| `pages.edit`     | Edit page metadata (title, slug, ...)   | Owner, Admin  |
| `pages.publish`  | Publish / unpublish pages               | Owner, Admin  |

### Content (postType rows)

| Capability                | Grants                                                              | Roles         |
|---------------------------|---------------------------------------------------------------------|---------------|
| `content.create`          | Create new draft postType rows                                      | Owner, Admin  |
| `content.edit.own`        | Edit rows where `author_user_id = me`                               | Owner, Admin  |
| `content.edit.any`        | Edit any row                                                        | Owner, Admin  |
| `content.publish.own`     | Publish own rows                                                    | Owner, Admin  |
| `content.publish.any`     | Publish any row                                                     | Owner, Admin  |
| `content.manage`          | Full content admin: edit / publish / status any row regardless of author | Owner, Admin |

The `own / any` split is the standard CMS workflow: a contributor can edit/publish their own posts; an editor (`content.edit.any`, `content.publish.any`) can manage everyone's.

### Data workspace (schema + raw rows + bundles)

The Data workspace is split from the Content workspace: Content owns row-level editorial via `content.*`; Data owns schema design, cross-collection row moves, and bundle export/import. Table read/manage is further split **system vs custom**, so a persona (e.g. Client) can browse and manage custom tables without ever seeing the four internal system tables (`posts`, `pages`, `components`, `layouts`).

| Capability                    | Grants                                                              | Roles         |
|-------------------------------|---------------------------------------------------------------------|---------------|
| `data.custom.tables.read`     | Open the Data workspace; see + browse **custom** tables and their field schemas | Owner, Admin, Client |
| `data.custom.tables.manage`   | Create, rename, delete **custom** tables; add/rename/delete fields; change primary field, route base. **Step-up gated** — changes public URL surface. | Owner, Admin |
| `data.system.tables.read`     | See + open the four **system** tables (`posts`/`pages`/`components`/`layouts`). | Owner, Admin |
| `data.system.tables.manage`   | On a system table: add/edit/remove **custom** fields and set the primary field. The table's identity (name, slug, route base, labels, kind) and its **built-in fields** are frozen for everyone — `assertSystemTableUpdateAllowed` rejects those edits server-side. Built-in field *values* on the structural system tables (pages/components/layouts) are read-only in the grid; `posts` built-ins stay editable. | Owner, Admin |
| `data.rows.move`       | `PATCH /data/rows/:id/table` — move a row to a different table (changes its public URL because route base differs per table). | Owner, Admin |
| `data.export`          | `GET /export` and `POST /import/preview` (read-only bundle ops). Row visibility is filtered against `canSeeAllDataRows`. | Owner, Admin |
| `data.import`          | `POST /import` (write). **`replace` strategy ALSO requires `content.manage` AND step-up.** Bundles carrying a site shell ALSO require `site.structure.edit`. | Owner, Admin |

### Media (granular split)

| Capability       | Grants                                                              | Roles         |
|------------------|---------------------------------------------------------------------|---------------|
| `media.read`     | Open the Media workspace; browse assets and folders; see thumbnails in pickers. Also gated by `/dashboard/media`. | Owner, Admin, Client |
| `media.write`    | Upload assets; edit metadata (alt text, caption, tags); manage folders; restore from trash. | Owner, Admin |
| `media.replace`  | Overwrite the bytes for an existing asset (variants regenerate). Split out from `media.write` because this silently swaps the bytes every page reference points at. | Owner, Admin |
| `media.delete`   | Soft-delete to trash; hard-purge (`?purge=1`) additionally requires step-up. Also gates `DELETE /media/folders/:id` (cascade). | Owner, Admin |

### Runtime + storage (granular split)

Was a single `runtime.manage`. Split because adapter election (bytes go to a plugin-provided backend) is a separate trust decision from `package.json` dependency editing.

| Capability             | Grants                                                              | Roles         |
|------------------------|---------------------------------------------------------------------|---------------|
| `runtime.dependencies` | Edit site `package.json` dependencies; trigger `POST /runtime/dependencies/resolve`. | Owner, Admin |
| `storage.elect`        | Elect a media storage adapter per asset role (originals / variants / avatars / fonts); elect/clear the variant delegate; verify adapter credentials. | Owner, Admin |
| `storage.migrate`      | Run the migration SSE that moves bytes between adapters after an election change. | Owner, Admin |

### Plugins (granular split)

Was a single `plugins.manage`. Split per the four very different blast radii: read / configure / install (RCE-class) / lifecycle.

| Capability             | Grants                                                              | Step-up | Roles         |
|------------------------|---------------------------------------------------------------------|---------|---------------|
| `plugins.read`         | List installed plugins; read masked settings; view event SSE stream; read schedule list. Also gates `/dashboard/plugins`. | no | Owner, Admin |
| `plugins.configure`    | Edit per-plugin settings via `PUT /plugins/:id/settings`; manage plugin records via `/plugins/:id/resources/*`. | yes (settings only) | Owner, Admin |
| `plugins.install`      | Install / upgrade / uninstall plugins; pack install; inspect-package. **RCE-class — runs third-party code on the host.** | yes (mutations) | Owner, Admin |
| `plugins.lifecycle`    | Enable / disable / restart plugins; schedule run-now / pause / resume. | yes (mutations) | Owner, Admin |

### Users + roles

| Capability       | Grants                                                              | Roles                                  |
|------------------|---------------------------------------------------------------------|----------------------------------------|
| `users.manage`   | Create, edit, delete, suspend users; assign roles                   | Owner, Admin                           |
| `roles.manage`   | Create, edit, delete custom roles; assign capabilities to roles     | **Owner only.** Admin does not get this. |

`roles.manage` is **owner-only by design** — only the installation owner edits capability grants. Admins manage everything else but can't grant themselves new capabilities.

### Audit

| Capability       | Grants                                                              | Roles         |
|------------------|---------------------------------------------------------------------|---------------|
| `audit.read`     | Read the dedicated `/admin/api/cms/audit` endpoint AND the Dashboard activity widget (previously leaked to every authenticated user — see A2 fix). | Owner, Admin |

### AI runtime

Was a single `ai.use`. Split so a Client persona can have chat assistance without the agent being able to mutate the editor store on their behalf.

| Capability             | Grants                                                              | Roles         |
|------------------------|---------------------------------------------------------------------|---------------|
| `ai.chat`              | Open AI conversations. The agent inherits the caller's capabilities: every tool declares `requiredCapabilities` (ANY-OF, mirroring its HTTP-route gate — e.g. `list_users` → `users.manage`, document reads → the `requireDataAccess` set, `list_media` → `media.read`) and is only offered when the caller holds one. `ai.chat` is the floor, not a blanket read grant. | Owner, Admin |
| `ai.tools.write`       | Enable canvas write tools (`setNodeProps`, `insertNode`, `deleteNode`, etc.) in registered AI conversations. Without this, the model has no write tools at all. | Owner, Admin |
| `ai.providers.manage`  | Create / update / delete AI provider credentials + per-scope defaults | Owner, Admin |
| `ai.audit.read`        | Read site-wide AI usage, cost, and error events across all users    | Owner, Admin |

### SEO

| Capability    | Grants                                                                | Roles        |
|---------------|------------------------------------------------------------------------|--------------|
| `seo.read`    | Open the SEO workspace (`/admin/tools/seo`); read metadata, robots, sitemap settings | Owner, Admin |
| `seo.manage`  | Edit target metadata, site SEO defaults, robots.txt, sitemap settings. Target writes additionally require the owning persona (`pages.edit` / content edit). `POST /seo/generate` additionally requires `ai.chat`. | Owner, Admin |

---

## Roles

Four built-in `SYSTEM_ROLES`:

| Role     | id        | Capabilities                                                                 | Boot behaviour |
|----------|-----------|------------------------------------------------------------------------------|----------------|
| Owner    | `owner`   | All 40 (`CORE_CAPABILITIES`)                                                 | Force-resynced on every boot. Owner-only `roles.manage`. |
| Admin    | `admin`   | All 40 except `roles.manage`                                                 | **Force-resynced on every boot** (changed from previous "seeded once"). Hand-edits restored at boot. |
| Client   | `client`  | `dashboard.read`, `site.read`, `site.content.edit`, `media.read`, `data.custom.tables.read` | Seeded once; freely editable. Sees custom tables only — never the system tables. |
| Member   | `member`  | (none)                                                                       | Seeded once; freely editable. |

A new capability added to the codebase appears on Owner AND Admin on the next boot (force-sync). Client and Member don't auto-update — users grant the new capability via the Roles admin page if they want it. Existing **custom** roles also don't auto-update — same reason.

The trade-off for Admin force-sync: an operator who hand-removes a capability from Admin through the UI gets it back at next boot. That's intentional — capability grants for built-in roles are a code-level decision. Operators who need a "limited admin" persona should create a custom role.

---

## Plugin permissions vs. core capabilities

Don't confuse them:

- **Core capabilities** (this doc) govern **what a logged-in human user can do in the admin**. Stored on `users.role`.
- **Plugin permissions** govern **what a plugin's code can do via the SDK**. Declared in `plugin.json`, approved at install. See [docs/features/plugin-system.md](../features/plugin-system.md).

A plugin route handler can additionally gate on a core capability:

```ts
// Standard: caller needs a core capability.
api.cms.routes.get('/admin-data', 'content.manage', handler)

// Any logged-in user — no specific capability needed, session cookie required.
api.cms.routes.authenticated.get('/me-private', handler)

// Anonymous-callable (webhooks). Plugin manifest must declare
// `cms.routes.public` permission. Install dialog flags this to the operator.
api.cms.routes.public.post('/webhook', handler)
```

The three forms map to `HostRouteAccess = { kind: 'capability'; capability } | { kind: 'authenticated' } | { kind: 'public' }`. The host's route forwarder dispatches on `kind`; the previous `capability: string | null` shape was ambiguous about whether `null` meant "authenticated" or "fully public", which was an A3-class footgun.

---

## Handler gates

The canonical pattern is in `server/auth/authz.ts`. Three helpers:

```ts
requireAuthenticatedUser(req, db)                        // any logged-in user
requireCapability(req, db, 'site.read')                  // one capability
requireAnyCapability(req, db, SITE_WRITE_CAPABILITIES)   // any of a set
```

Each returns `AuthUser | Response`. The handler checks `instanceof Response` and returns early on auth failure.

Step-up-gated actions:

```ts
requireStepUp(req, db)        // per-user sensitive-action step-up policy
```

See [docs/features/auth-and-access.md](../features/auth-and-access.md) for the full step-up flow.

The architecture test at `src/__tests__/architecture/cms-handlers-capability-gated.test.ts` walks every file under `server/handlers/cms/**.ts` and asserts each calls one of these helpers. The allowlist (with per-entry justifications) handles the few intentional exceptions (setup wizard, dispatcher, shared utilities).

---

## Any-of capability gates

The capability surface is a **single source of truth**: `CORE_CAPABILITIES` (and the derived `CoreCapability` type) lives only in `src/core/capabilities.ts` (`@core/capabilities`). `server/auth/capabilities.ts` imports and re-exports it, then adds the server-only concerns — the system-role definitions and the runtime guards. There is no parallel server list and no TypeBox union to keep in sync. Both files are **pure registries** of capabilities + roles — they do **not** hold capability groupings.

When an endpoint or UI affordance is reachable by **any of several capabilities**, that grouping is a small `const` defined **locally, at the point of use**, and named for what the gate protects (not for a capability family). It is then passed to `requireAnyCapability` (server) or `hasAnyCapability` (client). These lists routinely cross capability families.

Examples already in the tree:

| Constant                       | Defined in | Gate |
|--------------------------------|------------|------|
| `SITE_WRITE_CAPABILITIES`      | `server/handlers/cms/site.ts`, `src/admin/access.ts` | Save the draft site |
| `DATA_ACCESS_CAPABILITIES`, `DATA_EDIT_CAPABILITIES`, `DATA_PUBLISH_CAPABILITIES`, … | `server/handlers/cms/data/access.ts` | Data/content row operations |
| `CONTENT_ACCESS_CAPABILITIES`, `PLUGIN_READ_CAPABILITIES`, `DATA_WORKSPACE_READ_CAPABILITIES` | `src/admin/access.ts` | Admin workspace visibility |

There are deliberately **no** whole-family "super-set" constants (e.g. one `MEDIA_CAPABILITIES` listing every `media.*` cap). The system roles don't consume one — Owner uses the full `CORE_CAPABILITIES`, and Admin's grant list is written out leaf-by-leaf on purpose so every new capability forces a conscious per-PR decision about whether Admin gets it (see the `SYSTEM_ROLES` comment). A "future leaf auto-flows in" super-set is exactly the silent drift that design rejects. Group caps by what a gate needs, locally — never by family, globally.

---

## Cookbook

### Gate a handler

```ts
import { requireCapability } from '../../auth/authz'

if (req.method === 'GET') {
  const user = await requireCapability(req, db, 'audit.read')
  if (user instanceof Response) return user
  // … fetch + return audit events
}
```

### Gate the UI

The admin reads `currentUser.capabilities` from `/admin/api/cms/me`:

```ts
import { useAdminSession } from '@admin/session'

function AuditMenuItem() {
  const { user } = useAdminSession()
  if (!user.capabilities.includes('audit.read')) return null
  return <Link to="/admin/audit">Audit log</Link>
}
```

For workspace-level gating, `canAccessWorkspace(user, section)` is the single source of truth (`src/admin/access.ts`).

### Add a new capability

1. **Append** the string to `CORE_CAPABILITIES` in `src/core/capabilities.ts` — the single source of truth. The `CoreCapability` type updates automatically (`typeof CORE_CAPABILITIES[number]`), and the server picks it up via its import:
   ```ts
   export const CORE_CAPABILITIES = [
     // ...
     'analytics.read',
   ] as const
   ```
2. If it belongs to the Owner / Admin / Client default sets, add it to the matching `SYSTEM_ROLES` entry in `server/auth/capabilities.ts`. Owner + Admin force-sync on next boot.
4. Use it at the gate point:
   ```ts
   const user = await requireCapability(req, db, 'analytics.read')
   if (user instanceof Response) return user
   ```
5. Add a `CAPABILITY_META` entry + a `CAPABILITY_GROUPS` section in `src/admin/pages/users/utils/capabilities.ts` so the role-edit dialog renders a checkbox for it. The picker-coverage test fails until you do.
6. Existing **custom roles** will NOT have the new capability until users grant it through the Roles admin page.
7. Update this doc (table + adjacent docs) so agents and humans can find the new capability.

### Add a custom role

Owner-only (`roles.manage`). Admin → Roles → New role.

```ts
{
  id:           'editor-content-only',
  name:         'Content editor',
  description:  'Can manage all content rows but not site structure.',
  capabilities: ['dashboard.read', 'site.read', 'content.create', 'content.edit.any', 'content.publish.any', 'media.read', 'media.write'],
}
```

Saved to the `roles` table with `capabilities_json: CoreCapability[]`. Assigned to users via Admin → Users.

### Check capability without responding

```ts
import { userHasCapability, userHasAnyCapability } from '@auth/authz'

if (userHasCapability(user, 'audit.read')) { /* show menu */ }
if (userHasAnyCapability(user, SITE_WRITE_CAPABILITIES)) { /* allow save */ }
```

---

## Forbidden patterns

| Pattern                                                              | Use instead                                              |
|----------------------------------------------------------------------|----------------------------------------------------------|
| `user.role === 'admin'` to gate                                      | `userHasCapability(user, 'media.read')`                  |
| Hand-rolling a capability check (`user.capabilities.includes(...)`) | `userHasCapability` / `requireCapability`                |
| Granting `roles.manage` to non-Owner roles                           | Owner-only by design. Don't expand.                      |
| Skipping the boot-time `syncSystemRoles(db)` call in tests           | Tests should call it to set up a realistic state         |
| Adding a "permission" string outside the known set                   | Append to `CORE_CAPABILITIES` in `@core/capabilities` first; the derived type catches typos |
| Per-route ad-hoc auth that doesn't go through `requireCapability`    | Always use the helpers — gates aren't optional. The arch test catches missing gates. |
| Plugin route registered with `capability: null` (legacy shape)       | Use `api.cms.routes.authenticated.*` (logged-in user) or `api.cms.routes.public.*` (anonymous, requires `cms.routes.public` permission). |

---

## Related

- [docs/features/auth-and-access.md](../features/auth-and-access.md) — sessions, MFA, step-up, the auth funnel
- [docs/features/plugin-system.md](../features/plugin-system.md) — plugin permissions (separate from core capabilities), including `cms.routes.public`
- [docs/server.md](../server.md) — handler patterns
- Source-of-truth files:
  - `src/core/capabilities.ts` (`@core/capabilities`) — `CORE_CAPABILITIES` (the single canonical list) + the derived `CoreCapability` type
  - `server/auth/capabilities.ts` — imports/re-exports the list; owns `SYSTEM_ROLES`, `FORCE_SYNC_ROLE_IDS`, and the runtime guards
  - `server/auth/authz.ts` — `requireCapability`, `requireAnyCapability`, `userHasCapability`, `requireStepUp`
  - `server/repositories/roles.ts` — role persistence + `syncSystemRoles`
  - `src/admin/access.ts` — `canAccessWorkspace`, `firstAccessibleWorkspace`, per-workspace helpers
  - `src/admin/pages/users/utils/capabilities.ts` — `CAPABILITY_META`, `CAPABILITY_GROUPS`
  - `server/handlers/cms/roles.ts` — `/admin/api/cms/roles` (gated by `roles.manage`)
  - Architecture tests: `src/__tests__/architecture/capability-picker-coverage.test.ts`, `src/__tests__/architecture/cms-handlers-capability-gated.test.ts`
