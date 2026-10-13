/**
 * FragmentInsertAdapter — the I/O `commitFragmentPlan` needs, as an interface.
 *
 * The engine stays headless; the editor implements this against the CMS API
 * and its store (`src/admin/modals/InsertFragment/createFragmentInsertAdapter.ts`,
 * shared by the Insert fragment dialog and `api.editor.fragments`; the caller
 * supplies media bytes through `readMediaBytes`), and tests implement it in
 * memory.
 *
 * Interface only — no implementation here.
 */

import type { DataField } from '@core/data/schemas'
import type { FontEntry } from '@core/fonts'
import type { FragmentMedia, FragmentTableRow } from './schema'
import type { PlannedTableCreate } from './planTypes'
import type { FragmentApplyResult, ResolvedFragmentPlan } from './resolve'

export interface FragmentMediaRef {
  /** Media library id (what media cells hold). */
  id: string
  /** Public URL content references (what `src` and `url()` hold). */
  url: string
}

export interface FragmentInsertAdapter {
  /**
   * An asset already in the site's library that is the same file, or null.
   * The media library stores no content hash, so the editor matches by
   * filename, byte size and MIME type.
   */
  findMedia(media: FragmentMedia): Promise<FragmentMediaRef | null>

  /** Upload bytes into the media library. Forward `signal` to the request. */
  uploadMedia(file: {
    filename: string
    mimeType: string
    bytes: Uint8Array
    altText?: string
    signal?: AbortSignal
  }): Promise<FragmentMediaRef>

  /** Install a Google family the way the Typography panel does. */
  installGoogleFont(request: { family: string; variants: string[]; subsets: string[] }): Promise<FontEntry>

  /** Register a custom family from uploaded media files. */
  registerCustomFont(request: { family: string; files: { mediaAssetId: string; variant: string }[] }): Promise<FontEntry>

  /** Create a data table. Returns the server-minted id. */
  createTable(input: PlannedTableCreate['input']): Promise<{ id: string }>

  /** Replace a table's field list (used to append missing fields). */
  updateTableFields(tableId: string, fields: DataField[]): Promise<void>

  /**
   * Create one row (its slug comes from its `slug` cell, as for any row);
   * a `published` row is published after it is created.
   */
  createRow(tableId: string, row: Pick<FragmentTableRow, 'status' | 'cells'>): Promise<{ id: string }>

  /**
   * Apply the resolved plan in ONE store transaction, so one undo step reverts
   * the whole insert. Synchronous work behind an async signature: everything
   * the transaction needs is already resolved.
   */
  commit(plan: ResolvedFragmentPlan): Promise<FragmentApplyResult>
}
