/**
 * The I/O `commitFragmentPlan` and `commitThemePlan` need, as interfaces.
 *
 * Both share the media library and font installer (`FragmentAssetAdapter`);
 * a fragment insert also writes data tables and commits a resolved insert,
 * a theme commits a resolved theme. The engine stays headless; the editor
 * implements these against the CMS API and its store
 * (`src/admin/modals/InsertFragment/createFragmentInsertAdapter.ts`, shared
 * by the Insert fragment dialog and `api.editor.fragments`; the caller
 * supplies media bytes through `readMediaBytes`), and tests implement them in
 * memory.
 *
 * Interfaces only — no implementation here.
 */

import type { DataField } from '@core/data/schemas'
import type { FontEntry } from '@core/fonts'
import type { FragmentMedia, FragmentTableRow } from './schema'
import type { PlannedTableCreate } from './planTypes'
import type { FragmentApplyResult, ResolvedFragmentPlan } from './resolve'
import type { ResolvedThemePlan } from './applyTheme'

export interface FragmentMediaRef {
  /** Media library id (what media cells hold). */
  id: string
  /** Public URL content references (what `src` and `url()` hold). */
  url: string
}

/** Media library and font installer: what both fragments and themes upload through. */
export interface FragmentAssetAdapter {
  /**
   * An asset already in the site's library that is the same file, or null.
   * The editor reuses an asset only when its content hash matches.
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
}

export interface FragmentInsertAdapter extends FragmentAssetAdapter {
  /** Create a data table. Returns the server-minted id. */
  createTable(input: PlannedTableCreate['input']): Promise<{ id: string }>

  /** Add fields the current table does not already have. */
  appendTableFields(tableId: string, fields: DataField[]): Promise<void>

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

export interface ThemeApplyAdapter extends FragmentAssetAdapter {
  /**
   * Apply the resolved theme in ONE store transaction, so one undo step
   * reverts it. Rejects when the editor refused the write.
   */
  commit(plan: ResolvedThemePlan): Promise<void>
}
