/**
 * Freshness gate for the generated QuickJS plugin-bootstrap artifacts.
 *
 * The bootstrap is authored as real TypeScript under
 * `server/plugins/quickjs/bootstrap/src/` and bundled to committed string
 * artifacts under `…/bootstrap/generated/` by
 * `scripts/sync-plugin-bootstrap.ts`. The host evaluates those committed
 * strings inside the VM — so if the source changes but the artifact is not
 * regenerated, the VM would silently run stale code.
 *
 * This gate re-bundles the source in memory and asserts the committed
 * artifacts match byte-for-byte, exactly as `vendor-icons-fresh.test.ts` gates
 * the vendored icon set. Run `bun run bootstrap:sync` to refresh.
 */
import { describe, it, expect } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { buildBootstrapArtifacts } from '../../../scripts/sync-plugin-bootstrap'

const GENERATED_DIR = resolve(
  import.meta.dir,
  '../../../server/plugins/quickjs/bootstrap/generated',
)

describe('generated plugin bootstrap artifacts', () => {
  it('match a fresh bundle of bootstrap/src/ (run `bun run bootstrap:sync` if this fails)', async () => {
    const built = await buildBootstrapArtifacts()
    expect(built.length).toBeGreaterThan(0)

    for (const { outFile, content } of built) {
      const path = join(GENERATED_DIR, outFile)
      expect(existsSync(path), `missing generated/${outFile}`).toBe(true)
      // Tolerate CRLF working-tree line endings on Windows checkouts.
      const current = readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
      expect(
        current === content,
        `generated/${outFile} is stale — run \`bun run bootstrap:sync\``,
      ).toBe(true)
    }
  })
})
