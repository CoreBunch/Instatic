/**
 * Architecture gate: every publish/unpublish entry point in
 * `server/repositories/` bumps the publish version — either the bare
 * `bumpPublishVersion()` (publishes, which already hold the publish lock) or
 * `bumpPublishVersionSerialized()` (retractions outside a publish: unpublish,
 * soft-delete, table move) — and imports it from the publish-state module.
 *
 * Covered files:
 *   - server/repositories/publish.ts            (publishDraftSite)
 *   - server/repositories/data/publish.ts       (publishDataRow)
 *   - server/repositories/data/rows/mutations.ts (updateDataRowStatus — unpublish;
 *                                                 updateDataRowTable — route move)
 *
 * A simple text scan is sufficient — no AST parsing needed. The check matches
 * the pattern used by other architecture tests in this directory.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '../../..')

function read(relative: string): string {
  return readFileSync(join(ROOT, relative), 'utf-8')
}

/**
 * The relative import path from `file` to the publish-state module.
 * Asserted so that moving the publish-state module would break this gate.
 */
const EXPECTED_IMPORT_PATHS: Record<string, string> = {
  'server/repositories/publish.ts': "'../publish/publishState'",
  'server/repositories/data/publish.ts': "'../../publish/publishState'",
  'server/repositories/data/rows/mutations.ts': "'../../../publish/publishState'",
}

const FILES_UNDER_TEST = Object.keys(EXPECTED_IMPORT_PATHS)

describe('publish-bumps-cache-version', () => {
  for (const file of FILES_UNDER_TEST) {
    it(`${file} bumps the publish version`, () => {
      const src = read(file)
      const bumps =
        src.includes('bumpPublishVersion()') ||
        src.includes('bumpPublishVersionSerialized()')
      expect(bumps).toBe(true)
    })

    it(`${file} imports bumpPublishVersion from the publish-state module`, () => {
      const src = read(file)
      const expectedPath = EXPECTED_IMPORT_PATHS[file]
      // The import must name publishState as the source and include bumpPublishVersion.
      const hasImport =
        src.includes(`from ${expectedPath}`) &&
        src.includes('bumpPublishVersion')
      expect(hasImport).toBe(true)
    })
  }
})
