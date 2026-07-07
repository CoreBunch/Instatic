/**
 * Site-global sync sequence — the monotonic counter behind the multi-admin
 * sync substrate.
 *
 * Every transactional site-document save allocates ONE sequence number and
 * stamps it on the shell plus every row the save writes or soft-deletes.
 * Consumers:
 *   - conflict detection: a stored row whose `seq` is greater than the
 *     client's base seq was changed by someone else since the client loaded it;
 *   - delta reconciliation: `rows where seq > cursor` (indexed by
 *     `data_rows_table_seq_idx`) tells a reconnecting editor exactly what
 *     changed — including soft-deleted rows, which are stamped too;
 *   - event ordering: site-events carry the save's seq.
 *
 * The counter lives in the single-row `site_sync_state` table (id = 1),
 * bumped with a plain `update … returning` so the same code runs on Postgres
 * and SQLite (which has no sequence objects). Allocation MUST happen inside
 * the save transaction so two concurrent saves serialize on the counter row
 * and their seqs mirror commit order.
 */
import type { DbClient } from '../db/client'

/** Allocate the next site-global sync sequence number. Call inside the save transaction. */
export async function allocateSiteSeq(db: DbClient): Promise<number> {
  const { rows } = await db<{ seq: number }>`
    update site_sync_state
    set seq = seq + 1
    where id = 1
    returning seq
  `
  const seq = rows[0]?.seq
  if (seq === undefined) {
    throw new Error('[syncSequence] site_sync_state counter row missing — migrations not run?')
  }
  return Number(seq)
}
