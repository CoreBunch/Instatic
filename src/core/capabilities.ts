/**
 * Capability surface — THE single source of truth enumerating every
 * permission a CMS user can hold. Both the client and the server consume
 * this list: `server/auth/capabilities.ts` imports it (no parallel list),
 * and `src/admin/pages/users/utils/capabilities.ts` attaches the picker
 * metadata (label / description / group). The `CoreCapability` type below
 * is derived from this array via `typeof … [number]`, so adding a string
 * here flows everywhere automatically. The `capability-picker-coverage.test.ts`
 * gate enforces that every entry also has picker metadata.
 *
 * Site-editing capabilities are split three ways:
 *
 *   site.structure.edit  — add/remove/move/duplicate/rename nodes; manage
 *                          pages, visual components, classes registry.
 *   site.content.edit    — modify content-typed props on existing nodes
 *                          (text, richtext, image src/alt, link href, etc.).
 *                          The "client / copy editor" surface.
 *   site.style.edit      — modify CSS classes, style overrides, breakpoints,
 *                          framework tokens.
 *
 * The media / runtime+storage / plugins / data / AI families are each split
 * into granular leaves — see docs/reference/capabilities.md for the full
 * per-capability reference.
 */
export const CORE_CAPABILITIES = [
  'dashboard.read',
  'site.read',
  'site.structure.edit',
  'site.content.edit',
  'site.style.edit',
  'pages.edit',
  'pages.publish',
  'content.create',
  'content.edit.own',
  'content.edit.any',
  'content.publish.own',
  'content.publish.any',
  'content.manage',
  // Media — granular split (read/write/replace/delete).
  'media.read',
  'media.write',
  'media.replace',
  'media.delete',
  // Runtime + storage — split out of the old `runtime.manage`.
  'runtime.dependencies',
  'storage.elect',
  'storage.migrate',
  // Plugins — granular split (read/configure/install/lifecycle).
  'plugins.read',
  'plugins.configure',
  'plugins.install',
  'plugins.lifecycle',
  'users.manage',
  'roles.manage',
  'audit.read',
  // Data workspace — split from `content.manage`, and further split
  // system-vs-custom so a persona (e.g. "client") can see/manage custom tables
  // without ever seeing the internal system tables (posts/pages/components/
  // layouts). System-table identity + built-in fields are immutable for
  // everyone; `data.system.tables.manage` only governs custom fields +
  // primary-field selection on a system table.
  'data.custom.tables.read',
  'data.custom.tables.manage',
  'data.system.tables.read',
  'data.system.tables.manage',
  'data.rows.move',
  'data.export',
  'data.import',
  // AI runtime — `ai.chat` for conversations + read tools; `ai.tools.write`
  // for canvas write tools. See `docs/plans/2026-05-26-ai-runtime-rewrite.md`.
  'ai.chat',
  'ai.tools.write',
  'ai.providers.manage',
  'ai.audit.read',
  // SEO workspace — read the target index / edit metadata, robots, sitemap.
  'seo.read',
  'seo.manage',
] as const

export type CoreCapability = typeof CORE_CAPABILITIES[number]
