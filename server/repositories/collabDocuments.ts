/**
 * Collab document storage — one Yjs CRDT state blob per collab doc
 * (`<kind>:<rowId>`, see @core/collab). The blob is the live-editing source
 * of truth; the relay (server/collab) derives JSON into `data_rows` / `site`
 * on every persist so the publisher and non-editor reads never touch CRDT
 * state. `seq` counts persists (diagnostics + future delta APIs).
 */
import { placeholder, type DbClient } from '../db/client'

export async function getCollabDocumentState(
  db: DbClient,
  docId: string,
): Promise<Uint8Array | null> {
  const { rows } = await db<{ state_blob: Uint8Array }>`
    select state_blob from collab_documents
    where doc_id = ${docId}
    limit 1
  `
  const blob = rows[0]?.state_blob
  if (!blob) return null
  return blob instanceof Uint8Array ? blob : new Uint8Array(blob)
}

export async function putCollabDocumentState(
  db: DbClient,
  docId: string,
  state: Uint8Array,
): Promise<void> {
  await db`
    insert into collab_documents (doc_id, state_blob, seq)
    values (${docId}, ${state}, 1)
    on conflict (doc_id) do update
      set state_blob = excluded.state_blob,
          seq = collab_documents.seq + 1,
          updated_at = current_timestamp
  `
}

export async function deleteCollabDocuments(
  db: DbClient,
  docIds: readonly string[],
): Promise<void> {
  if (docIds.length === 0) return
  const placeholders = docIds.map((_, i) => placeholder(db.dialect, i + 1)).join(', ')
  await db.unsafe(
    `delete from collab_documents where doc_id in (${placeholders})`,
    [...docIds],
  )
}
