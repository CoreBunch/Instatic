import { useState } from 'react'
import { pushToast } from '@ui/components/Toast'
import {
  importSiteBundle,
  parseSiteBundle,
  previewSiteBundle,
  SiteBundleParseError,
} from '@core/persistence/cmsTransfer'
import { getErrorMessage } from '@core/utils/errorMessage'
import {
  CMS_SITE_BUNDLE_IMPORTED_EVENT,
  requestCmsSiteReload,
} from '@admin/state/adminEvents'
import type {
  BundlePreview,
  ImportResult as CmsImportResult,
  ImportStrategy,
  SiteBundle,
} from '@core/data/bundleSchema'

interface CmsBundleState {
  filename: string
  bundle: SiteBundle
  preview: BundlePreview | null
  previewLoading: boolean
  previewError: string | null
  strategy: ImportStrategy
  importing: boolean
}

interface UseCmsBundleImportInput {
  closeModal: () => void
  onImportComplete?: () => void
}

function isCmsBundleCandidate(file: File): boolean {
  return file.name.toLowerCase().endsWith('.json') || file.type === 'application/json'
}

function pluralize(count: number, singular: string, plural: string): string {
  return count === 1 ? `1 ${singular}` : `${count} ${plural}`
}

function buildCmsImportToastBody(result: CmsImportResult): string {
  const strategyLabel: Record<ImportStrategy, string> = {
    replace: 'Replace',
    'merge-add': 'Merge-add',
    'merge-overwrite': 'Merge-overwrite',
  }
  const parts: string[] = [strategyLabel[result.strategy]]

  if (result.rowsInserted > 0) {
    parts.push(pluralize(result.rowsInserted, 'row added', 'rows added'))
  }
  if (result.rowsReplaced > 0) {
    parts.push(pluralize(result.rowsReplaced, 'row replaced', 'rows replaced'))
  }
  if (result.rowsSkipped > 0) {
    parts.push(pluralize(result.rowsSkipped, 'row skipped', 'rows skipped'))
  }
  if (result.mediaImported > 0) {
    parts.push(pluralize(result.mediaImported, 'media file imported', 'media files imported'))
  }

  return parts.join(' · ')
}

function previewHasContent(preview: BundlePreview | null): boolean {
  if (!preview) return false
  return preview.tables.some((table) => table.inBundle > 0) || preview.totals.mediaFiles > 0
}

export function describeCmsBundleLoadError(err: unknown): string {
  return err instanceof SiteBundleParseError
    ? `CMS bundle JSON is invalid: ${err.message}`
    : getErrorMessage(err, 'Failed to read CMS bundle')
}

export function useCmsBundleImport({
  closeModal,
  onImportComplete,
}: UseCmsBundleImportInput) {
  const [cmsBundleState, setCmsBundleState] = useState<CmsBundleState | null>(null)

  async function loadCmsBundleFile(file: File): Promise<boolean> {
    if (!isCmsBundleCandidate(file)) return false

    const raw = await file.text()
    const bundle = parseSiteBundle(raw)

    setCmsBundleState({
      filename: file.name,
      bundle,
      preview: null,
      previewLoading: true,
      previewError: null,
      strategy: 'merge-add',
      importing: false,
    })

    try {
      const preview = await previewSiteBundle(bundle)
      setCmsBundleState((prev) => prev?.bundle === bundle
        ? { ...prev, preview, previewLoading: false, previewError: null }
        : prev)
    } catch (err) {
      console.error('[SiteImportModal] bundle preview failed:', err)
      setCmsBundleState((prev) => prev?.bundle === bundle
        ? {
            ...prev,
            preview: null,
            previewLoading: false,
            previewError: getErrorMessage(err, 'Failed to preview bundle'),
          }
        : prev)
    }

    return true
  }

  function clearCmsBundle() {
    setCmsBundleState(null)
  }

  function setCmsStrategy(strategy: ImportStrategy) {
    setCmsBundleState((prev) => prev ? { ...prev, strategy } : prev)
  }

  async function importCmsBundle() {
    if (
      !cmsBundleState ||
      !cmsBundleState.preview ||
      !previewHasContent(cmsBundleState.preview) ||
      cmsBundleState.importing
    ) {
      return
    }

    setCmsBundleState({ ...cmsBundleState, importing: true })
    try {
      const importResult = await importSiteBundle(cmsBundleState.bundle, cmsBundleState.strategy)
      pushToast({
        kind: 'success',
        title: 'Import complete',
        body: buildCmsImportToastBody(importResult),
        location: 'site-workspace',
      })
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event(CMS_SITE_BUNDLE_IMPORTED_EVENT))
      }
      requestCmsSiteReload()
      onImportComplete?.()
      closeModal()
    } catch (err) {
      console.error('[SiteImportModal] bundle import failed:', err)
      pushToast({
        kind: 'error',
        title: 'Import failed',
        body: getErrorMessage(err, 'Unknown import error'),
        location: 'site-workspace',
      })
      setCmsBundleState((prev) => prev ? { ...prev, importing: false } : prev)
    }
  }

  const cmsCanImport =
    cmsBundleState !== null &&
    cmsBundleState.preview !== null &&
    previewHasContent(cmsBundleState.preview) &&
    !cmsBundleState.previewLoading &&
    !cmsBundleState.importing
  const cmsImportButtonLabel = cmsBundleState?.importing
    ? 'Importing...'
    : cmsBundleState?.strategy === 'replace'
      ? 'Replace site'
      : cmsBundleState?.strategy === 'merge-overwrite'
        ? 'Overwrite rows'
        : 'Add rows'

  return {
    cmsBundleState,
    cmsCanImport,
    cmsImportButtonLabel,
    clearCmsBundle,
    importCmsBundle,
    loadCmsBundleFile,
    setCmsStrategy,
  }
}
