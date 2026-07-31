/**
 * Collab document storage — one Yjs CRDT state blob per collab doc
 * (`<kind>:<rowId>`, see @core/collab). The blob is the live-editing source
 * of truth; the relay (server/collab) derives JSON into `data_rows` / `site`
 * on every persist so the publisher and non-editor reads never touch CRDT
 * state. `seq` counts persists (diagnostics + future delta APIs).
 *
 * `generation` is the doc's CRDT LINEAGE id (see @core/collab/protocol). A
 * reset deletes the row, so the next open mints a fresh one — which is exactly
 * what lets both ends refuse a frame from a dead lineage.
 */
import { placeholder, type DbClient } from '../db/client'

export interface StoredCollabDocument {
  state: Uint8Array
  /** '' for rows written before migration 023 — the relay mints one on open. */
  generation: string
}

export async function getCollabDocumentState(
  db: DbClient,
  docId: string,
): Promise<StoredCollabDocument | null> {
  const { rows } = await db<{ state_blob: Uint8Array; generation: string }>`
    select state_blob, generation from collab_documents
    where doc_id = ${docId}
    limit 1
  `
  const row = rows[0]
  if (!row?.state_blob) return null
  return {
    state: row.state_blob instanceof Uint8Array ? row.state_blob : new Uint8Array(row.state_blob),
    generation: typeof row.generation === 'string' ? row.generation : '',
  }
}

export async function putCollabDocumentState(
  db: DbClient,
  docId: string,
  state: Uint8Array,
  generation: string,
): Promise<void> {
  await db`
    insert into collab_documents (doc_id, state_blob, seq, generation)
    values (${docId}, ${state}, 1, ${generation})
    on conflict (doc_id) do update
      set state_blob = excluded.state_blob,
          seq = collab_documents.seq + 1,
          generation = excluded.generation,
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
