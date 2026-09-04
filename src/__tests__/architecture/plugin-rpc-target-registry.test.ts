/**
 * Architecture gate — the plugin RPC target registry is internally consistent.
 *
 * `ApiCallSchemas` (apiCallSchema.ts) is the SINGLE SOURCE of the accepted
 * target set. Two other tables must stay in lockstep with it, and this gate
 * locks that in so a future edit can't silently desync them:
 *
 *   1. `host/apiDispatch.ts:apiHandlers` — one handler per target. This is
 *      ALSO compile-enforced (`satisfies HostApiHandlerTable`, where the table
 *      type is keyed by `keyof typeof ApiCallSchemas`); the runtime check here
 *      is the cheap belt-and-braces companion the security review asked for. A
 *      target with a schema but no handler used to be a runtime
 *      "handler is not a function"; now it's both a compile error and a test
 *      failure.
 *
 *   2. `protocol/targets.ts:TARGET_PERMISSIONS` — the ONE target→permission
 *      map both the host dispatcher and the VM bootstrap consume. Every key
 *      must be a real target, every privileged target must map to exactly one
 *      permission, and the full table is locked to today's contract so a
 *      handler can never silently require a DIFFERENT permission than before.
 */

import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { ALLOWED_API_TARGETS } from '../../../server/plugins/protocol/apiCallSchema'
import { TARGET_PERMISSIONS } from '../../../server/plugins/protocol/targets'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

async function read(relative: string): Promise<string> {
  return await readFile(join(ROOT, relative), 'utf-8')
}

/**
 * Extract the keys of the `apiHandlers` object literal from apiDispatch.ts
 * source — `'<target>': handleFoo,`. Source-scanned (not imported) so the
 * gate has no import side effects on the host registry.
 */
function extractHandlerTargets(source: string): string[] {
  const block = source.match(/const apiHandlers = \{([\s\S]*?)\n\} satisfies/)
  if (!block) return []
  return [...block[1].matchAll(/^\s*'([a-z][a-zA-Z.]+)':/gm)].map((m) => m[1])
}

/**
 * The locked target→permission contract. Reproduces today's behavior EXACTLY.
 * Targets intentionally ungated (no permission) are omitted, mirroring the map.
 * Changing any line here is a deliberate security decision, not a refactor.
 */
const EXPECTED_TARGET_PERMISSIONS: Record<string, string> = {
  'cms.routes.register': 'cms.routes',
  'cms.hooks.on': 'cms.hooks',
  'cms.hooks.filter': 'cms.hooks',
  'cms.hooks.emit': 'cms.hooks',
  'cms.loops.registerSource': 'loops.register',
  'cms.storage.list': 'cms.storage',
  'cms.storage.create': 'cms.storage',
  'cms.storage.update': 'cms.storage',
  'cms.storage.delete': 'cms.storage',
  'network.fetch': 'network.outbound',
  'cms.schedule.register': 'cms.schedule',
  'cms.schedule.cancel': 'cms.schedule',
  'cms.media.upsertRemote': 'media.import.remote',
  'cms.media.registerStorageAdapter': 'media.storage.adapter',
  'cms.media.registerUrlTransformer': 'media.url.transform',
  'cms.media.registerVariantDelegate': 'media.variant.delegate',
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
}

/** Targets that intentionally require NO permission (must be absent from map). */
const UNGATED_TARGETS = [
  'cms.settings.replace',
  'network.abort',
  'crypto.digest',
  'crypto.signHmac',
]

describe('plugin RPC target registry', () => {
  it('every schema target has exactly one handler, and there are no orphan handlers', async () => {
    const dispatch = await read('server/plugins/host/apiDispatch.ts')
    const handlerTargets = extractHandlerTargets(dispatch).sort()
    const schemaTargets = [...ALLOWED_API_TARGETS].sort()

    expect(schemaTargets.length).toBeGreaterThan(15)
    // Set equality: a missing handler (runtime "is not a function") or an
    // extra handler with no schema both fail here.
    expect(handlerTargets).toEqual(schemaTargets)
  })

  it('every TARGET_PERMISSIONS key is a real api-call target', () => {
    const targetSet = new Set<string>(ALLOWED_API_TARGETS)
    for (const target of Object.keys(TARGET_PERMISSIONS)) {
      expect(targetSet.has(target), `"${target}" is not a known api-call target`).toBe(true)
    }
  })

  it('the target→permission table reproduces the locked security contract', () => {
    expect({ ...TARGET_PERMISSIONS }).toEqual(EXPECTED_TARGET_PERMISSIONS)
  })

  it('intentionally ungated targets carry no permission', () => {
    for (const target of UNGATED_TARGETS) {
      // Present as a real target…
      expect(ALLOWED_API_TARGETS as readonly string[]).toContain(target)
      // …but deliberately absent from the permission map.
      expect(Object.hasOwn(TARGET_PERMISSIONS, target)).toBe(false)
    }
  })
})
