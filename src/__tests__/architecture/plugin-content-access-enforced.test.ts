/**
 * Architecture gate: every plugin content RPC must enforce both the permission
 * grant AND the manifest's `contentAccess[]` allowlist.
 *
 * The shape we lock (after permission enforcement was centralized):
 *   - The `cms.content.*` permission grant is enforced CENTRALLY in
 *     apiDispatch.ts (driven by `TARGET_PERMISSIONS`) before any handler runs,
 *     so every content target carries a `cms.content.*` permission in the map.
 *   - Every handler still decides per table, with the mode NAMED, which the
 *     central permission gate cannot express. One check,
 *     `pluginHasContentTableAccess` (grant and mode), reached directly (answer
 *     as if the table were not there, or leave it out of a list), through
 *     `tableFor` (one refusal for a missing and a forbidden table) or, for
 *     page trees, through `assertTreeReach`. An entry matches by slug or via the `@own-created`
 *     marker (resolved against the table's `createdByPluginId`). There is no
 *     mode-less "has any access" helper.
 *   - `cms.content.tables.create` records the creating plugin on the table
 *     row — the durable fact the `@own-created` marker resolves against.
 *
 * The matrix of (permission, mode) per handler is documented in the handler
 * header comment; this test enforces presence of the central pairing + the
 * per-table helper — finer-grained mode coverage is in the per-handler tests
 * (`server/plugins/host/registry.test.ts`, `.../handlers/content.test.ts`).
 */

import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

async function read(relative: string): Promise<string> {
  return await readFile(join(ROOT, relative), 'utf-8')
}

/**
 * Extract every `export async function handleContent*` body from the
 * handler module. Returns `[name, bodyText]` pairs. Crude but adequate
 * for an architecture gate — the file is tightly structured and a
 * future refactor that splits one big switch into per-file handlers
 * would still surface the function-per-RPC pattern.
 */
function extractContentHandlers(source: string): Array<{ name: string; body: string }> {
  const out: Array<{ name: string; body: string }> = []
  const re = /export async function (handleContent\w+)\([^)]*\)[^{]*\{([\s\S]*?)^\}/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(source))) {
    out.push({ name: m[1], body: m[2] })
  }
  return out
}

describe('plugin content handlers — access enforced', () => {
  it('every cms.content.* target is centrally gated by a cms.content.* permission', async () => {
    // Permission enforcement is centralized in apiDispatch.ts and driven by
    // TARGET_PERMISSIONS. Lock that (a) the central assert call is present and
    // (b) every content target carries a cms.content.* permission in the map.
    const dispatch = await read('server/plugins/host/apiDispatch.ts')
    expect(dispatch).toContain('assertHostPluginPermission(entry, requiredPermission)')

    const targets = await read('server/plugins/protocol/targets.ts')
    const pairs = [...targets.matchAll(/'(cms\.content\.[a-zA-Z.]+)':\s*'([a-z][a-zA-Z.]+)'/g)]
    expect(pairs.length).toBeGreaterThan(15) // ~20 content RPCs, sanity
    for (const [, target, permission] of pairs) {
      expect(
        permission.startsWith('cms.content.'),
        `Content target "${target}" must map to a cms.content.* permission, got "${permission}"`,
      ).toBe(true)
    }
  })

  it('every content handler decides access per table, with the mode named', async () => {
    const source = [
      await read('server/plugins/host/handlers/content.ts'),
      await read('server/plugins/host/handlers/contentTree.ts'),
    ].join('\n')
    const handlers = extractContentHandlers(source)
    expect(handlers.length).toBeGreaterThan(18)
    // The mode-less helper is gone and stays gone.
    expect(source).not.toContain('hasContentTableAccess(entry.manifest')
    expect(await read('server/plugins/host/registry.ts')).not.toContain('export function hasContentTableAccess')

    // The two handlers with no table to decide for.
    const noTable = new Set([
      'handleContentTablesCreate',   // gated by cms.content.tables.manage; names a NEW table
      'handleContentRepublishAll',   // re-renders published pages; audience decided per page
    ])
    const MODE = `(?:\\[?'(?:read|write|publish|delete)')`
    const decides = new RegExp(
      `tableFor\\(\\w+, \\w+, \\w+, ${MODE}` +
        `|pluginHasContentTableAccess\\(\\w+, \\w+, ${MODE}` +
        `|assertTreeReach\\(\\w+, \\w+, \\w+, \\w+, ${MODE}`,
    )
    // One check, one place: the handlers do not carry a second one.
    expect(source).not.toContain('assertContentTableAccess')
    expect(await read('server/plugins/host/registry.ts')).not.toContain('export function assertContentTableAccess')
    for (const { name, body } of handlers) {
      if (noTable.has(name)) continue
      expect(decides.test(body), `Handler "${name}" must decide table access with a named mode`).toBe(true)
    }
  })

  it('tables.create records the creating plugin; the marker resolves against it', async () => {
    // The `@own-created` contentAccess marker is only sound if BOTH halves
    // hold: the create handler stamps the host-authenticated plugin id on
    // the table row, and the registry matcher resolves the marker against
    // that stored creator (never against the slug).
    const source = await read('server/plugins/host/handlers/content.ts')
    const create = extractContentHandlers(source).find((h) => h.name === 'handleContentTablesCreate')
    expect(create, 'handleContentTablesCreate must exist').toBeDefined()
    expect(
      create?.body.includes('createdByPluginId: msg.pluginId'),
      'handleContentTablesCreate must record the caller as createdByPluginId',
    ).toBe(true)

    const registry = await read('server/plugins/host/registry.ts')
    expect(registry).toContain('OWN_CREATED_TABLES_MARKER')
    expect(registry).toContain('table.createdByPluginId === manifest.id')
  })
})
