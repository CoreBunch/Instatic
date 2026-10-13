/**
 * createFragmentInsertAdapter — wires `commitFragmentPlan` to the CMS API and
 * the editor store.
 *
 * Media: the library stores no content hash, so "the same file" is a
 * non-deleted asset with the same filename, byte size and MIME type (the
 * library is listed once per insert). Anything else is uploaded through the
 * same endpoint as the Media workspace.
 * Fonts: Google families through the Typography panel's installer, custom
 * families registered from the uploaded files.
 * Tables and rows: the Data API; a published fragment row is published.
 * Commit: `insertFragment` on the editor store — one undo step.
 *
 * Every server write runs through `runStepUp`: creating a table is a
 * sensitive action, and a `step_up_required` answer opens the password
 * prompt and retries instead of failing the insert.
 */

import type { FragmentInsertAdapter } from '@core/fragments'
import { installCmsGoogleFont, registerCustomFont } from '@core/persistence/cmsFonts'
import { listCmsMediaAssets, uploadCmsMediaAsset, type CmsMediaAsset } from '@core/persistence/cmsMedia'
import {
  createCmsDataRow,
  createCmsDataTable,
  publishCmsDataRow,
  updateCmsDataTable,
} from '@core/persistence/cmsData'
import { useEditorStore } from '@site/store/store'

type RunStepUp = <T>(action: () => Promise<T>) => Promise<T>

export function createFragmentInsertAdapter(runStepUp: RunStepUp): FragmentInsertAdapter {
  let library: Promise<CmsMediaAsset[]> | null = null

  return {
    async findMedia(media) {
      if (media.sizeBytes === undefined) return null
      library ??= listCmsMediaAssets()
      const match = (await library).find((asset) =>
        asset.deletedAt === null
        && asset.filename === media.filename
        && asset.mimeType === media.mimeType
        && asset.sizeBytes === media.sizeBytes,
      )
      return match ? { id: match.id, url: match.publicPath } : null
    },

    async uploadMedia({ filename, mimeType, bytes, altText, signal }) {
      // Bytes come from fflate / File APIs — always a plain ArrayBuffer.
      const file = new File([bytes.slice().buffer as ArrayBuffer], filename, { type: mimeType })
      const asset = await runStepUp(() => uploadCmsMediaAsset(file, { signal, altText }))
      return { id: asset.id, url: asset.publicPath }
    },

    installGoogleFont: (request) => runStepUp(() => installCmsGoogleFont(request)),

    registerCustomFont: (request) => runStepUp(() => registerCustomFont(request)),

    async createTable(input) {
      const table = await runStepUp(() => createCmsDataTable(input))
      return { id: table.id }
    },

    async updateTableFields(tableId, fields) {
      await runStepUp(() => updateCmsDataTable(tableId, { fields }))
    },

    async createRow(tableId, row) {
      const created = await runStepUp(() => createCmsDataRow(tableId, { cells: row.cells }))
      if (row.status === 'published') await runStepUp(() => publishCmsDataRow(created.id))
      return { id: created.id }
    },

    async commit(plan) {
      const result = useEditorStore.getState().insertFragment(plan)
      if (!result) {
        throw new Error('The editor could not place the fragment here. Select where it should go and try again.')
      }
      return result
    },
  }
}
