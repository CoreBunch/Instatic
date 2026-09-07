/**
 * Architecture gate: every plugin content RPC must enforce both the permission
 * grant AND the manifest's `contentAccess[]` allowlist.
 *
 * The shape we lock (after permission enforcement was centralized):
 *   - The `cms.content.*` permission grant is enforced CENTRALLY in
 *     apiDispatch.ts (driven by `TARGET_PERMISSIONS`) before any handler runs,
 *     so every content target carries a `cms.content.*` permission in the map.
 *   - Every per-table handler (anything that takes a `tableSlug` arg) still
 *     calls `assertContentTableAccess` for the targeted slug + mode — the
 *     per-table check the central permission gate cannot express.
 *
 * The matrix of (permission, mode) per handler is documented in the handler
 * header comment; this test enforces presence of the central pairing + the
 * per-table helper — finer-grained mode coverage is in the per-handler tests.
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

  it('every per-table handler also calls assertContentTableAccess', async () => {
    const source = await read('server/plugins/host/handlers/content.ts')
    const handlers = extractContentHandlers(source)

    // Per-table handlers are everything whose first argv unpacks a
    // tableSlug or operates on entries / tree of a specific table.
    // Cross-table handlers (List on tables, search, republishAll) are
    // intentionally allowlisted — their authorization model differs.
    const crossTableAllowlist = new Set([
      'handleContentLocalesList',    // registry metadata; requires cms.content.read
      'handleContentTablesList',     // intersects with allowlist itself
      'handleContentTablesCreate',   // gated by cms.content.tables.manage
      'handleContentRepublishAll',   // operates on all published pages
      'handleContentSearch',         // intersects with allowlist itself
      'handleContentSnapshot',       // looks up table from rowId, then asserts
      'handleContentTreeRead',       // looks up table from rowId, then asserts
      'handleContentTreeMutate',     // looks up table from rowId, then asserts
      'handleContentTreeReplace',    // looks up table from rowId, then asserts
    ])

    for (const { name, body } of handlers) {
      if (crossTableAllowlist.has(name)) continue
      expect(
        body.includes('assertContentTableAccess('),
        `Per-table handler "${name}" must call assertContentTableAccess`,
      ).toBe(true)
    }
  })
})
