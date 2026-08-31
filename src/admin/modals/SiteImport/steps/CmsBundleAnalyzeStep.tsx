import { useState, type CSSProperties } from 'react'
import { Checkbox } from '@ui/components/Checkbox'
import { Switch } from '@ui/components/Switch'
import { assignRailAccents, railTintVar, type RailAccent } from '@ui/railAccent'
import { formatBytes } from '@admin/lib/formatBytes'
import { DragAndDropSolidIcon } from 'pixel-art-icons/icons/drag-and-drop-solid'
import { FileTextSolidIcon } from 'pixel-art-icons/icons/file-text-solid'
import { HeadingIcon } from 'pixel-art-icons/icons/heading'
import { ImageSolidIcon } from 'pixel-art-icons/icons/image-solid'
import type { BundleImportSelection, BundlePreview, ImportStrategy } from '@core/data/bundleSchema'
import type { CmsBundleState } from '../shared/useCmsBundleImport'
import { ImportStepper } from '../shared/ImportStepper'
import styles from './AnalyzeStep.module.css'

type CmsReviewCategoryKind = 'mode' | 'site' | 'table' | 'media' | 'mediaFolders' | 'redirects'

interface CmsReviewCategory {
  id: string
  testId: string
  kind: CmsReviewCategoryKind
  label: string
  count: number
  included: boolean
  accent: RailAccent
  tint: string
  tableId?: string
}

interface CmsBundleAnalyzeStepProps {
  state: CmsBundleState
  siteName: string
  onSelectionChange: (selection: BundleImportSelection) => void
  onStrategyChange: (strategy: ImportStrategy) => void
  onChooseDifferentFile: () => void
}

const STRATEGY_OPTIONS: ReadonlyArray<{
  value: ImportStrategy
  title: string
  description: string
}> = [
  {
    value: 'replace',
    title: 'Replace everything',
    description: 'Wipe the local site and replace it with the bundle. Best for full restores.',
  },
  {
    value: 'merge-add',
    title: 'Merge: add only',
    description: "Insert bundle rows that do not exist locally. Existing rows stay untouched.",
  },
  {
    value: 'merge-overwrite',
    title: 'Merge: overwrite',
    description: 'Upsert bundle rows. Local rows that are not in the bundle stay untouched.',
  },
]

export function CmsBundleAnalyzeStep({
  state,
  siteName,
  onSelectionChange,
  onStrategyChange,
  onChooseDifferentFile,
}: CmsBundleAnalyzeStepProps) {
  const [active, setActive] = useState('mode')
  const categories = buildCmsReviewCategories(state)
  const activeCategory = categories.find((category) => category.id === active) ?? categories[0]

  if (state.previewLoading || state.previewError || !state.preview) {
    return (
      <div className={styles.step}>
        <ImportStepper current="review" />
        <div className={styles.statusBlock}>
          {state.previewLoading && (
            <p className={styles.statusText} aria-live="polite">
              Checking bundle against current site&hellip;
            </p>
          )}
          {state.previewError && (
            <>
              <p role="alert" className={styles.errorText}>
                {state.previewError}
              </p>
              <button type="button" className={styles.link} onClick={onChooseDifferentFile}>
                Choose a different file
              </button>
            </>
          )}
        </div>
      </div>
    )
  }
  const preview = state.preview

  function patch(next: Partial<BundleImportSelection>) {
    onSelectionChange({ ...state.selection, ...next })
  }

  function tableRows(tableId: string) {
    return state.bundle.rows.filter((row) => row.tableId === tableId)
  }

  function tableSelection(tableId: string) {
    return state.selection.tables.find((entry) => entry.tableId === tableId)
  }

  function selectTableAll(tableId: string) {
    const nextTables = state.selection.tables.filter((entry) => entry.tableId !== tableId)
    nextTables.push({ tableId })
    patch({ tables: nextTables })
  }

  function selectTableNone(tableId: string) {
    patch({ tables: state.selection.tables.filter((entry) => entry.tableId !== tableId) })
  }

  function toggleTableRow(tableId: string, rowId: string) {
    const rows = tableRows(tableId)
    const current = tableSelection(tableId)
    const selected = new Set(
      current
        ? current.rowIds ?? rows.map((row) => row.id)
        : [],
    )
    if (selected.has(rowId)) selected.delete(rowId)
    else selected.add(rowId)
    const nextTables = state.selection.tables.filter((entry) => entry.tableId !== tableId)
    if (selected.size > 0) {
      nextTables.push({ tableId, rowIds: rows.every((row) => selected.has(row.id)) ? undefined : [...selected] })
    }
    patch({ tables: nextTables })
  }

  function toggleMedia(assetId: string) {
    const media = state.bundle.media ?? []
    const selected = new Set(
      state.selection.includeMedia
        ? state.selection.mediaIds ?? media.map((asset) => asset.id)
        : [],
    )
    if (selected.has(assetId)) selected.delete(assetId)
    else selected.add(assetId)
    patch({
      includeMedia: selected.size > 0,
      mediaIds: selected.size === media.length ? undefined : [...selected],
    })
  }

  function selectAllMedia() {
    patch({ includeMedia: true, mediaIds: undefined })
  }

  function selectNoMedia() {
    patch({ includeMedia: false, mediaIds: undefined })
  }

  function renderActiveCategory() {
    if (!activeCategory) return null
    switch (activeCategory.kind) {
      case 'mode':
        return renderCmsMode(state.filename, preview, state.strategy, onStrategyChange)
      case 'site':
        return renderCmsSiteShell(state, patch)
      case 'table':
        return activeCategory.tableId
          ? renderCmsTable(state, activeCategory.tableId, tableRows, tableSelection, selectTableAll, selectTableNone, toggleTableRow)
          : null
      case 'media':
        return renderCmsMedia(state, selectAllMedia, selectNoMedia, toggleMedia)
      case 'mediaFolders':
        return renderCmsToggleCategory({
          title: 'Media folders',
          sub: 'Restore the media library folder tree',
          count: state.selection.includeMediaFolders ? state.bundle.mediaFolders?.length ?? 0 : 0,
          total: state.bundle.mediaFolders?.length ?? 0,
          checked: state.selection.includeMediaFolders,
          onCheckedChange: (checked) => patch({ includeMediaFolders: checked }),
        })
      case 'redirects':
        return renderCmsToggleCategory({
          title: 'Redirects',
          sub: 'Restore published URL redirects that target selected rows',
          count: state.selection.includeRedirects ? state.bundle.redirects?.length ?? 0 : 0,
          total: state.bundle.redirects?.length ?? 0,
          checked: state.selection.includeRedirects,
          onCheckedChange: (checked) => patch({ includeRedirects: checked }),
        })
    }
  }

  return (
    <div className={styles.step}>
      <ImportStepper current="review" />

      <div className={styles.layout}>
        <aside className={styles.nav}>
          <p className={styles.navLead}>
            Importing into <strong>{siteName}</strong>
            <span className={styles.navLeadLine}>
              {preview.meta.sourceSiteName ? `From ${preview.meta.sourceSiteName}` : state.filename}
            </span>
          </p>
          <div className={styles.navList}>
            {categories.map((category) => (
              <button
                key={category.id}
                type="button"
                className={styles.navItem}
                data-active={activeCategory?.id === category.id ? 'true' : undefined}
                data-accent={category.accent}
                data-testid={`site-import-review-category-${category.testId}`}
                onClick={() => setActive(category.id)}
              >
                <span className={styles.navDot} style={{ '--tint': category.tint } as CSSProperties} />
                <span className={styles.navLabel}>{category.label}</span>
                <span className={styles.navCount}>{category.count}</span>
                <span className={styles.navState} data-on={category.included ? 'true' : undefined} />
              </button>
            ))}
          </div>
          <div className={styles.navBottom}>
            <button type="button" className={styles.addFiles} onClick={onChooseDifferentFile} disabled={state.importing}>
              <span className={styles.addFilesIcon}>
                <DragAndDropSolidIcon size={15} />
              </span>
              <span className={styles.addFilesText}>
                <span className={styles.addFilesTitle}>Choose different file</span>
                <span className={styles.addFilesSub}>Drop another bundle, HTML, media, or browse</span>
              </span>
            </button>
          </div>
        </aside>

        <div className={styles.detail}>
          {renderActiveCategory()}
        </div>
      </div>
    </div>
  )
}

function buildCmsReviewCategories(state: CmsBundleState): CmsReviewCategory[] {
  const tablePreviewById = new Map(state.preview?.tables.map((table) => [table.id, table]))
  const baseCategories: Array<Omit<CmsReviewCategory, 'accent' | 'tint'>> = [
    {
      id: 'mode',
      testId: 'mode',
      kind: 'mode',
      label: 'Import mode',
      count: 1,
      included: true,
    },
  ]

  if (state.bundle.site) {
    baseCategories.push({
      id: 'site',
      testId: 'site',
      kind: 'site',
      label: 'Theme & settings',
      count: 1,
      included: state.selection.includeSite,
    })
  }

  for (const table of state.bundle.tables) {
    const preview = tablePreviewById.get(table.id)
    const tableSelection = state.selection.tables.find((entry) => entry.tableId === table.id)
    baseCategories.push({
      id: `table:${table.id}`,
      testId: table.id,
      kind: 'table',
      label: table.name,
      count: preview?.inBundle ?? state.bundle.rows.filter((row) => row.tableId === table.id).length,
      included: tableSelection !== undefined,
      tableId: table.id,
    })
  }

  if ((state.bundle.media?.length ?? 0) > 0) {
    const selectedMedia = state.selection.includeMedia
      ? state.selection.mediaIds?.length ?? state.bundle.media?.length ?? 0
      : 0
    baseCategories.push({
      id: 'media',
      testId: 'media',
      kind: 'media',
      label: 'Media',
      count: state.bundle.media?.length ?? selectedMedia,
      included: selectedMedia > 0,
    })
  }

  if ((state.bundle.mediaFolders?.length ?? 0) > 0) {
    baseCategories.push({
      id: 'mediaFolders',
      testId: 'media-folders',
      kind: 'mediaFolders',
      label: 'Media folders',
      count: state.bundle.mediaFolders?.length ?? 0,
      included: state.selection.includeMediaFolders,
    })
  }

  if ((state.bundle.redirects?.length ?? 0) > 0) {
    baseCategories.push({
      id: 'redirects',
      testId: 'redirects',
      kind: 'redirects',
      label: 'Redirects',
      count: state.bundle.redirects?.length ?? 0,
      included: state.selection.includeRedirects,
    })
  }

  const accents = assignRailAccents(baseCategories, (category) => `cms-import:${category.id}:${category.label}`)
  return baseCategories.map((category, index) => {
    const accent = accents[index] ?? 'mint'
    return {
      ...category,
      accent,
      tint: railTintVar(accent),
    }
  })
}

function renderCmsMode(
  filename: string,
  preview: BundlePreview,
  strategy: ImportStrategy,
  onStrategyChange: (strategy: ImportStrategy) => void,
) {
  const exportedAt = new Date(preview.meta.exportedAt).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
  const hasContent =
    preview.tables.some((table) => table.inBundle > 0) ||
    preview.totals.mediaFiles > 0 ||
    preview.totals.mediaFolders > 0 ||
    preview.totals.redirects > 0

  return (
    <>
      <DetailHead
        title="Import mode"
        sub="Choose how this bundle lands in the current site"
        count={1}
        total={1}
        hideBulk
      />
      <div className={styles.cmsMetaRows}>
        <p className={styles.cmsMetaRow}>
          <span className={styles.cmsMetaLabel}>Bundle</span>
          <span className={styles.cmsMetaValue}>{filename}</span>
        </p>
        <p className={styles.cmsMetaRow}>
          <span className={styles.cmsMetaLabel}>Exported</span>
          <span className={styles.cmsMetaValue}>{exportedAt}</span>
        </p>
        {preview.meta.sourceSiteName && (
          <p className={styles.cmsMetaRow}>
            <span className={styles.cmsMetaLabel}>From site</span>
            <span className={styles.cmsMetaValue}>{preview.meta.sourceSiteName}</span>
          </p>
        )}
      </div>
      {!hasContent && (
        <p className={styles.empty}>No content in this bundle.</p>
      )}
      <fieldset className={styles.strategyFieldset}>
        {STRATEGY_OPTIONS.map((option) => (
          <label
            key={option.value}
            className={styles.strategyOption}
            data-selected={strategy === option.value ? 'true' : undefined}
          >
            <input
              type="radio"
              name="cms-import-strategy"
              value={option.value}
              checked={strategy === option.value}
              onChange={() => onStrategyChange(option.value)}
              className={styles.strategyRadio}
            />
            <span className={styles.strategyContent}>
              <span className={styles.strategyTitle}>{option.title}</span>
              <span className={styles.strategyDescription} data-tone={option.value === 'replace' ? 'danger' : undefined}>
                {option.description}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
    </>
  )
}

function renderCmsSiteShell(
  state: CmsBundleState,
  patch: (next: Partial<BundleImportSelection>) => void,
) {
  return renderCmsToggleCategory({
    title: 'Theme & settings',
    sub: 'Site shell, breakpoints, classes, files, and runtime settings',
    count: state.selection.includeSite ? 1 : 0,
    total: 1,
    checked: state.selection.includeSite,
    onCheckedChange: (checked) => patch({ includeSite: checked }),
  })
}

function renderCmsTable(
  state: CmsBundleState,
  tableId: string,
  tableRows: (tableId: string) => CmsBundleState['bundle']['rows'],
  tableSelection: (tableId: string) => BundleImportSelection['tables'][number] | undefined,
  selectTableAll: (tableId: string) => void,
  selectTableNone: (tableId: string) => void,
  toggleTableRow: (tableId: string, rowId: string) => void,
) {
  const table = state.bundle.tables.find((entry) => entry.id === tableId)
  if (!table) return null
  const rows = tableRows(tableId)
  const selection = tableSelection(tableId)
  const selectedRows = selection
    ? selection.rowIds?.length ?? rows.length
    : 0

  return (
    <>
      <DetailHead
        title={table.name}
        sub={table.kind === 'page' ? 'Pages from the exported site' : 'Rows from this exported table'}
        count={selectedRows}
        total={rows.length}
        onAll={() => selectTableAll(tableId)}
        onNone={() => selectTableNone(tableId)}
      />
      {rows.length === 0 ? (
        <p className={styles.empty}>No rows in this table.</p>
      ) : (
        <div className={styles.rows}>
          {rows.map((row) => {
            const on = selection
              ? selection.rowIds?.includes(row.id) ?? true
              : false
            return (
              <div key={row.id} className={styles.listRow} data-off={on ? undefined : 'true'}>
                <Checkbox
                  checked={on}
                  boxSize="sm"
                  onCheckedChange={() => toggleTableRow(tableId, row.id)}
                  aria-label={`Include ${rowTitle(row, table.primaryFieldId)}`}
                />
                <div className={styles.info}>
                  <span className={styles.title}>{rowTitle(row, table.primaryFieldId)}</span>
                  <span className={styles.meta}>{row.slug || row.id}</span>
                </div>
                <span className={styles.chip}>{row.status}</span>
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}

function renderCmsMedia(
  state: CmsBundleState,
  selectAllMedia: () => void,
  selectNoMedia: () => void,
  toggleMedia: (assetId: string) => void,
) {
  const media = state.bundle.media ?? []
  const selectedMedia = state.selection.includeMedia
    ? new Set(state.selection.mediaIds ?? media.map((asset) => asset.id))
    : new Set<string>()

  return (
    <>
      <DetailHead
        title="Media"
        sub="Imported into the Media library"
        count={selectedMedia.size}
        total={media.length}
        onAll={selectAllMedia}
        onNone={selectNoMedia}
      />
      {media.length === 0 ? (
        <p className={styles.empty}>No media files in this bundle.</p>
      ) : (
        <div className={styles.tileGrid}>
          {media.map((asset) => {
            const on = selectedMedia.has(asset.id)
            return (
              <div key={asset.id} className={styles.mediaTile}>
                {renderCmsMediaThumb(asset)}
                <div className={styles.info}>
                  <span className={styles.title}>{asset.filename}</span>
                  <span className={styles.meta}>{asset.mimeType} · {formatBytes(asset.sizeBytes, { maxUnit: 'MB' })}</span>
                </div>
                <Switch
                  checked={on}
                  switchSize="sm"
                  onCheckedChange={() => toggleMedia(asset.id)}
                  aria-label={`Include ${asset.filename}`}
                />
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}

function renderCmsToggleCategory(input: {
  title: string
  sub: string
  count: number
  total: number
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <>
      <DetailHead
        title={input.title}
        sub={input.sub}
        count={input.count}
        total={input.total}
        hideBulk
      />
      <div className={styles.rows}>
        <div className={styles.cmsToggleRow}>
          <div className={styles.info}>
            <span className={styles.title}>{input.title}</span>
            <span className={styles.meta}>{input.total} in bundle</span>
          </div>
          <Switch
            checked={input.checked}
            switchSize="sm"
            onCheckedChange={input.onCheckedChange}
            aria-label={`Include ${input.title}`}
          />
        </div>
      </div>
    </>
  )
}

function renderCmsMediaThumb(asset: NonNullable<CmsBundleState['bundle']['media']>[number]) {
  if (asset.mimeType.startsWith('image/') && asset.bytesBase64) {
    return (
      <img
        className={styles.thumb}
        src={`data:${asset.mimeType};base64,${asset.bytesBase64}`}
        alt=""
      />
    )
  }

  const Icon = asset.mimeType.startsWith('image/')
    ? ImageSolidIcon
    : asset.mimeType.startsWith('font/')
      ? HeadingIcon
      : FileTextSolidIcon
  const style = asset.mimeType.startsWith('image/') && asset.dominantColor
    ? { '--cms-thumb-bg': asset.dominantColor } as CSSProperties
    : undefined

  return (
    <span className={styles.cmsFileThumb} style={style} aria-hidden="true">
      <Icon size={17} />
    </span>
  )
}

interface DetailHeadProps {
  title: string
  sub: string
  count: number
  total: number
  hideBulk?: boolean
  onAll?: () => void
  onNone?: () => void
}

function DetailHead({ title, sub, count, total, hideBulk, onAll, onNone }: DetailHeadProps) {
  return (
    <div className={styles.detHead}>
      <div className={styles.detHeadText}>
        <h3 className={styles.detHeadTitle}>{title}</h3>
        <span className={styles.sectionSub}>{sub}</span>
      </div>
      {!hideBulk && (
        <div className={styles.detHeadBulk}>
          <span className={styles.detHeadCount}>
            {count} of {total}
          </span>
          <button type="button" className={styles.link} onClick={onAll}>
            All
          </button>
          <span className={styles.bulkSep}>·</span>
          <button type="button" className={styles.link} onClick={onNone}>
            None
          </button>
        </div>
      )}
    </div>
  )
}

function rowTitle(row: CmsBundleState['bundle']['rows'][number], primaryFieldId: string): string {
  const primary = row.cells[primaryFieldId]
  if (typeof primary === 'string' && primary.trim()) return primary
  return row.slug || row.id
}
