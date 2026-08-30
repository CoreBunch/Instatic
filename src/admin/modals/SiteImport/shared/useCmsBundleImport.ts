import { useState } from 'react'
import { pushToast } from '@ui/components/Toast'
import { StepUpCancelledMessage, useStepUp } from '@admin/shared/StepUp'
import {
  importSiteBundle,
  importSiteBundleArchive,
  parseSiteBundle,
  previewSiteBundle,
  readSiteBundleArchiveManifestFile,
  siteBundlePreviewFromArchiveManifest,
  SiteBundleParseError,
} from '@core/persistence/cmsTransfer'
import { getErrorMessage } from '@core/utils/errorMessage'
import {
  filterSiteBundleForImportSelection,
  isFullBundleImportSelection,
  makeFullBundleImportSelection,
} from '@core/data/bundleSelection'
import {
  CMS_SITE_BUNDLE_IMPORTED_EVENT,
  requestCmsSiteReload,
} from '@admin/state/adminEvents'
import type {
  BundleImportSelection,
  BundlePreview,
  ImportResult as CmsImportResult,
  ImportStrategy,
  SiteBundle,
} from '@core/data/bundleSchema'

export interface CmsBundleState {
  filename: string
  bundle: SiteBundle
  archiveFile: File | null
  preview: BundlePreview | null
  previewLoading: boolean
  previewError: string | null
  strategy: ImportStrategy
  selection: BundleImportSelection
  importing: boolean
}

interface UseCmsBundleImportInput {
  onImportComplete?: () => void
}

function isCmsBundleJsonCandidate(file: File): boolean {
  return file.name.toLowerCase().endsWith('.json') || file.type === 'application/json'
}

function pluralize(count: number, singular: string, plural: string): string {
  return count === 1 ? `1 ${singular}` : `${count} ${plural}`
}

function buildCmsImportToastBody(result: CmsImportResult): string {
  const strategyLabel: Record<CmsImportResult['strategy'], string> = {
    replace: 'Replace',
    'replace-selected': 'Replace selected',
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
  if (result.mediaFoldersImported > 0) {
    parts.push(pluralize(result.mediaFoldersImported, 'folder imported', 'folders imported'))
  }
  if (result.redirectsImported > 0) {
    parts.push(pluralize(result.redirectsImported, 'redirect imported', 'redirects imported'))
  }

  return parts.join(' · ')
}

function selectionHasContent(bundle: SiteBundle, selection: BundleImportSelection): boolean {
  if (selection.includeSite && bundle.site) return true

  const tableSelections = new Map(selection.tables.map((table) => [table.tableId, table.rowIds]))
  if (bundle.rows.some((row) => {
    const rowIds = tableSelections.get(row.tableId)
    return rowIds === undefined
      ? tableSelections.has(row.tableId)
      : rowIds.includes(row.id)
  })) {
    return true
  }

  if (selection.includeMedia) {
    if (selection.mediaIds === undefined) {
      if ((bundle.media?.length ?? 0) > 0) return true
    } else if (selection.mediaIds.length > 0) {
      return true
    }
  }

  return (
    selection.includeMediaFolders && (bundle.mediaFolders?.length ?? 0) > 0
  ) || (
    selection.includeRedirects && (bundle.redirects?.length ?? 0) > 0
  )
}

export function describeCmsBundleLoadError(err: unknown): string {
  return err instanceof SiteBundleParseError
    ? `CMS bundle is invalid: ${err.message}`
    : getErrorMessage(err, 'Failed to read CMS bundle')
}

export function useCmsBundleImport({
  onImportComplete,
}: UseCmsBundleImportInput) {
  const { runStepUp } = useStepUp()
  const [cmsBundleState, setCmsBundleState] = useState<CmsBundleState | null>(null)

  async function beginCmsBundlePreview(
    filename: string,
    bundle: SiteBundle,
    archiveFile: File | null,
  ): Promise<void> {
    setCmsBundleState({
      filename,
      bundle,
      archiveFile,
      preview: null,
      previewLoading: true,
      previewError: null,
      strategy: 'merge-add',
      selection: makeFullBundleImportSelection(bundle),
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
  }

  async function loadCmsBundleFile(file: File): Promise<boolean> {
    if (!isCmsBundleJsonCandidate(file)) return false

    const raw = await file.text()
    const bundle = parseSiteBundle(raw)
    await beginCmsBundlePreview(file.name, bundle, null)

    return true
  }

  async function loadCmsBundleArchiveFile(file: File): Promise<boolean> {
    const manifest = await readSiteBundleArchiveManifestFile(file)
    if (!manifest) return false

    await beginCmsBundlePreview(file.name, siteBundlePreviewFromArchiveManifest(manifest), file)
    return true
  }

  function clearCmsBundle() {
    setCmsBundleState(null)
  }

  function setCmsStrategy(strategy: ImportStrategy) {
    setCmsBundleState((prev) => prev ? { ...prev, strategy } : prev)
  }

  function setCmsSelection(selection: BundleImportSelection) {
    setCmsBundleState((prev) => prev ? { ...prev, selection } : prev)
  }

  async function importCmsBundle(selectionOverride?: BundleImportSelection): Promise<CmsImportResult | null> {
    if (
      !cmsBundleState ||
      !cmsBundleState.preview ||
      !selectionHasContent(cmsBundleState.bundle, selectionOverride ?? cmsBundleState.selection) ||
      cmsBundleState.importing
    ) {
      return null
    }

    const selection = selectionOverride ?? cmsBundleState.selection
    setCmsBundleState({ ...cmsBundleState, importing: true })
    try {
      const selectedBundle = filterSiteBundleForImportSelection(cmsBundleState.bundle, selection)
      const archiveSelection = isFullBundleImportSelection(cmsBundleState.bundle, selection)
        ? undefined
        : selection
      const importResult = await runStepUp(() => cmsBundleState.archiveFile
        ? importSiteBundleArchive(cmsBundleState.archiveFile, cmsBundleState.strategy, archiveSelection)
        : importSiteBundle(selectedBundle, cmsBundleState.strategy))
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
      setCmsBundleState((prev) => prev ? { ...prev, importing: false } : prev)
      return importResult
    } catch (err) {
      if (err instanceof Error && err.message === StepUpCancelledMessage) {
        setCmsBundleState((prev) => prev ? { ...prev, importing: false } : prev)
        return null
      }
      console.error('[SiteImportModal] bundle import failed:', err)
      pushToast({
        kind: 'error',
        title: 'Import failed',
        body: getErrorMessage(err, 'Unknown import error'),
        location: 'site-workspace',
      })
      setCmsBundleState((prev) => prev ? { ...prev, importing: false } : prev)
      throw err
    }
  }

  const cmsCanImport =
    cmsBundleState !== null &&
    cmsBundleState.preview !== null &&
    selectionHasContent(cmsBundleState.bundle, cmsBundleState.selection) &&
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
    loadCmsBundleArchiveFile,
    loadCmsBundleFile,
    setCmsSelection,
    setCmsStrategy,
  }
}
