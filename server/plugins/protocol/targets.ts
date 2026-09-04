/**
 * Target → required-permission map — the SINGLE source pairing each plugin
 * RPC target with the permission it requires.
 *
 * BOTH enforcement layers read this one table:
 *   - HOST: `host/apiDispatch.ts` looks up `TARGET_PERMISSIONS[target]` and
 *     calls `assertHostPluginPermission` before invoking the handler. This is
 *     the kernel-of-correctness check.
 *   - VM:   the QuickJS bootstrap (`quickjs/bootstrap/src/buildApi.ts`) imports
 *     this same map (it is bundled into the VM artifact by `bootstrap:sync`)
 *     and drives its synchronous defense-in-depth `assertPermission` from it.
 *
 * Because there is now ONE source instead of two parallel inline copies, a
 * handler can no longer assert a DIFFERENT permission than the VM advertises —
 * the privilege-drift gap a type checker never caught is closed.
 *
 * Permission authority: both layers validate against the operator-approved
 * `grantedPermissions` set, NEVER the declared `permissions` array.
 *
 * Targets deliberately ABSENT from this map require NO permission and are
 * intentionally ungated:
 *   - `cms.settings.replace` — any active plugin may update its own settings.
 *   - `network.abort`        — a plugin without `network.outbound` can never
 *                              mint a live abortId, so the lookup just no-ops.
 *   - `crypto.digest` / `crypto.signHmac` — pure computation, no I/O, no
 *                              privilege escalation (same model as `Math`/`JSON`).
 *
 * Conditional/extra checks that CANNOT live in a static target→permission map
 * stay in their handlers (host + VM both keep them):
 *   - `cms.routes.register` with `access.kind === 'public'` additionally
 *     requires `cms.routes.public` (surfaced in the install consent dialog).
 *   - `cms.content.*` handlers additionally enforce the manifest's
 *     `contentAccess[]` allowlist via `assertContentTableAccess`.
 *
 * NOTE: this module is bundled into the QuickJS VM via `buildApi.ts`. Keep its
 * runtime surface a PURE DATA literal — only `import type` is allowed, so the
 * bundler never drags TypeBox (or anything else) into the sandbox artifact.
 */

import type { PluginPermission } from '@core/plugin-sdk'
import type { AllowedApiTarget } from './apiCallSchema'

export const TARGET_PERMISSIONS = {
  // Routes — base permission. Public-access routes also require
  // `cms.routes.public`, asserted conditionally in the route handler/shim.
  'cms.routes.register': 'cms.routes',
  // Hooks
  'cms.hooks.on': 'cms.hooks',
  'cms.hooks.filter': 'cms.hooks',
  'cms.hooks.emit': 'cms.hooks',
  // Loops
  'cms.loops.registerSource': 'loops.register',
  // Storage
  'cms.storage.list': 'cms.storage',
  'cms.storage.create': 'cms.storage',
  'cms.storage.update': 'cms.storage',
  'cms.storage.delete': 'cms.storage',
  // Network — outbound HTTP (allowlist enforced separately in host/network.ts).
  'network.fetch': 'network.outbound',
  // Scheduled jobs
  'cms.schedule.register': 'cms.schedule',
  'cms.schedule.cancel': 'cms.schedule',
  // Media subsystem — remote ingestion plus three independent extension surfaces.
  'cms.media.upsertRemote': 'media.import.remote',
  'cms.media.registerStorageAdapter': 'media.storage.adapter',
  'cms.media.registerUrlTransformer': 'media.url.transform',
  'cms.media.registerVariantDelegate': 'media.variant.delegate',
  // CMS content — read / write / publish / delete / tables.manage.
  'cms.content.tables.list': 'cms.content.read',
  'cms.content.tables.get': 'cms.content.read',
  'cms.content.tables.create': 'cms.content.tables.manage',
  'cms.content.entries.list': 'cms.content.read',
  'cms.content.entries.get': 'cms.content.read',
  'cms.content.entries.getBySlug': 'cms.content.read',
  'cms.content.entries.create': 'cms.content.write',
  'cms.content.entries.update': 'cms.content.write',
  'cms.content.entries.delete': 'cms.content.delete',
  'cms.content.entries.publish': 'cms.content.publish',
  'cms.content.entries.moveTable': 'cms.content.write',
  'cms.content.entries.createMany': 'cms.content.write',
  'cms.content.entries.updateMany': 'cms.content.write',
  'cms.content.entries.deleteMany': 'cms.content.delete',
  'cms.content.tree.read': 'cms.content.read',
  'cms.content.tree.mutate': 'cms.content.write',
  'cms.content.tree.replace': 'cms.content.write',
  'cms.content.search': 'cms.content.read',
  'cms.content.snapshot': 'cms.content.read',
  'cms.content.republishAll': 'cms.content.publish',
} satisfies Partial<Record<AllowedApiTarget, PluginPermission>>
