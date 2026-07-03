/**
 * collab_documents repository — CRDT state blob round-trips through both the
 * upsert path and the delete path on a real migrated database.
 */
import { describe, expect, it } from 'bun:test'
import {
  deleteCollabDocuments,
  getCollabDocumentState,
  putCollabDocumentState,
} from '../../../server/repositories/collabDocuments'
import { createTestDb } from '../helpers/createTestDb'

describe('collab_documents repository', () => {
  it('put → get round-trips bytes and increments seq on upsert', async () => {
    const { db, cleanup } = await createTestDb()
    try {
      expect(await getCollabDocumentState(db, 'page:x')).toBeNull()

      const first = new Uint8Array([1, 2, 3, 250])
      await putCollabDocumentState(db, 'page:x', first)
      expect([...(await getCollabDocumentState(db, 'page:x'))!]).toEqual([1, 2, 3, 250])

      const second = new Uint8Array([9, 9])
      await putCollabDocumentState(db, 'page:x', second)
      expect([...(await getCollabDocumentState(db, 'page:x'))!]).toEqual([9, 9])

      const { rows } = await db<{ seq: number }>`
        select seq from collab_documents where doc_id = ${'page:x'}
      `
      expect(Number(rows[0].seq)).toBe(2)
    } finally {
      await cleanup()
    }
  })

  it('deleteCollabDocuments removes exactly the named docs', async () => {
    const { db, cleanup } = await createTestDb()
    try {
      await putCollabDocumentState(db, 'page:a', new Uint8Array([1]))
      await putCollabDocumentState(db, 'page:b', new Uint8Array([2]))
      await deleteCollabDocuments(db, ['page:a', 'page:missing'])
      expect(await getCollabDocumentState(db, 'page:a')).toBeNull()
      expect(await getCollabDocumentState(db, 'page:b')).not.toBeNull()
    } finally {
      await cleanup()
    }
  })
})
