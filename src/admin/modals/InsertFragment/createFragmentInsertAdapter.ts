/**
 * createFragmentInsertAdapter / createThemeApplyAdapter — wire
 * `commitFragmentPlan` and `commitThemePlan` to the CMS API and the editor
 * store. Both share the media and font half (`createFragmentAssetAdapter`).
 *
 * Media: reuse an asset only when its content hash matches. Otherwise send
 * the bytes through the same upload endpoint as the Media workspace.
 * Fonts: Google families through the Typography panel's installer, custom
 * families registered from the uploaded files.
 * Tables and rows: the Data API; a published fragment row is published.
 * Commit: `insertFragment` on the editor store at the caller's placement,
 * or `applyTheme`, in one undo step.
 *
 * Every server write runs through `runStepUp`: creating a table is a
 * sensitive action, and a `step_up_required` answer opens the password
 * prompt and retries instead of failing the insert.
 */

import type { EditorFragmentPlacement } from '@site/store/slices/fragmentsSlice'
import type {
  FragmentAssetAdapter,
  FragmentInsertAdapter,
  ThemeApplyAdapter,
} from '@core/fragments'
import { installCmsGoogleFont, registerCustomFont } from '@core/persistence/cmsFonts'
import { findCmsMediaByContentHash, uploadCmsMediaAsset } from '@core/persistence/cmsMedia'
import {
  createCmsDataRow,
  createCmsDataTable,
  publishCmsDataRow,
  updateCmsDataTable,
} from '@core/persistence/cmsData'
import { useEditorStore } from '@site/store/store'

type RunStepUp = <T>(action: () => Promise<T>) => Promise<T>

function guardWrite(runStepUp: RunStepUp, assertCurrentTarget: () => void): RunStepUp {
  return (action) => runStepUp(() => {
    assertCurrentTarget()
    return action()
  })
}

function createFragmentAssetAdapter(write: RunStepUp, assertCurrentTarget: () => void): FragmentAssetAdapter {
  return {
    async findMedia(media) {
      assertCurrentTarget()
      if (!media.key) return null
      const matches = await findCmsMediaByContentHash([media.key])
      const match = matches.find(asset => asset.contentHash === media.key)
      return match ? { id: match.id, url: match.publicPath } : null
    },

    async uploadMedia({ filename, mimeType, bytes, altText, signal }) {
      // Bytes come from fflate / File APIs — always a plain ArrayBuffer.
      const file = new File([bytes.slice().buffer as ArrayBuffer], filename, { type: mimeType })
      const asset = await write(() => uploadCmsMediaAsset(file, { signal, altText }))
      return { id: asset.id, url: asset.publicPath }
    },

    installGoogleFont: (request) => write(() => installCmsGoogleFont(request)),

    registerCustomFont: (request) => write(() => registerCustomFont(request)),
  }
}

export function createFragmentInsertAdapter(
  runStepUp: RunStepUp,
  assertCurrentTarget: () => void,
  placement: EditorFragmentPlacement = 'after-selection',
): FragmentInsertAdapter {
  const write = guardWrite(runStepUp, assertCurrentTarget)
  return {
    ...createFragmentAssetAdapter(write, assertCurrentTarget),

    async createTable(input) {
      const table = await write(() => createCmsDataTable(input))
      return { id: table.id }
    },

    async appendTableFields(tableId, fields) {
      await write(() => updateCmsDataTable(tableId, { appendFields: fields }))
    },

    async createRow(tableId, row) {
      const created = await write(() => createCmsDataRow(tableId, { cells: row.cells }))
      if (row.status === 'published') await write(() => publishCmsDataRow(created.id))
      return { id: created.id }
    },

    async commit(plan) {
      assertCurrentTarget()
      const result = useEditorStore.getState().insertFragment(plan, placement)
      if (!result) {
        throw new Error('The editor could not place the fragment here. Select where it should go and try again.')
      }
      return result
    },
  }
}

export function createThemeApplyAdapter(runStepUp: RunStepUp, assertCurrentTarget: () => void): ThemeApplyAdapter {
  return {
    ...createFragmentAssetAdapter(guardWrite(runStepUp, assertCurrentTarget), assertCurrentTarget),

    async commit(plan) {
      assertCurrentTarget()
      if (!useEditorStore.getState().applyTheme(plan)) {
        throw new Error('The editor could not apply the theme. Reload the site editor and try again.')
      }
    },
  }
}
