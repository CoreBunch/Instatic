import { describe, test, expect } from 'bun:test'
import * as os from 'node:os'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { createTestDb } from '../helpers/createTestDb'
import { removeDataRowArtefact } from '../../../server/publish/publishRow'
import {
  getActiveSlot,
  readArtefact,
  swapSlot,
  updateArtefactInPlace,
} from '../../../server/publish/staticArtefact'

/**
 * ISS-039: Layer A serves baked artefacts straight off disk with no
 * publishVersion awareness. Unpublishing / deleting a row bumped the cache
 * version but left the file, so retracted content stayed publicly served.
 * Retraction must prune the artefact from the active slot.
 */
describe('removeDataRowArtefact', () => {
  async function withRow(status: string): Promise<{
    db: Awaited<ReturnType<typeof createTestDb>>['db']
    uploadsDir: string
    rowId: string
    slug: string
    artefactPath: string
    cleanup: () => Promise<void>
  }> {
    const { db, cleanup: dbCleanup } = await createTestDb()
    const uploadsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'instatic-uploads-'))
    const rowId = crypto.randomUUID()
    const slug = 'ghost-post'
    // 'pages' is a seeded system table with route_base '' → public path "/<slug>".
    await db`
      insert into data_rows (id, table_id, slug, status, cells_json)
      values (${rowId}, ${'pages'}, ${slug}, ${status}, ${{ title: 'Ghost', slug }})`
    const artefactPath = `/${slug}`
    await updateArtefactInPlace(uploadsDir, artefactPath, '<html>ghost content</html>')
    // Establish the `current` symlink so readArtefact (Layer A) can see it.
    await swapSlot(uploadsDir, await getActiveSlot(uploadsDir))
    return {
      db,
      uploadsDir,
      rowId,
      slug,
      artefactPath,
      cleanup: async () => {
        await fs.rm(uploadsDir, { recursive: true, force: true })
        await dbCleanup()
      },
    }
  }

  test('removes the baked artefact for an unpublished row', async () => {
    const ctx = await withRow('unpublished')
    try {
      expect(await readArtefact(ctx.uploadsDir, ctx.artefactPath)).toContain('ghost content')
      await removeDataRowArtefact(ctx.db, ctx.uploadsDir, ctx.rowId, ctx.slug)
      expect(await readArtefact(ctx.uploadsDir, ctx.artefactPath)).toBeNull()
    } finally {
      await ctx.cleanup()
    }
  })

  test('removes the artefact even for a soft-deleted row (deleted_at set)', async () => {
    const ctx = await withRow('published')
    try {
      await ctx.db`update data_rows set deleted_at = current_timestamp where id = ${ctx.rowId}`
      expect(await readArtefact(ctx.uploadsDir, ctx.artefactPath)).toContain('ghost content')
      await removeDataRowArtefact(ctx.db, ctx.uploadsDir, ctx.rowId, ctx.slug)
      expect(await readArtefact(ctx.uploadsDir, ctx.artefactPath)).toBeNull()
    } finally {
      await ctx.cleanup()
    }
  })
})
