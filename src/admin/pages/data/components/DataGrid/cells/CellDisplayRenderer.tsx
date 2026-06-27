/**
 * CellDisplayRenderer — read-only display rendering for grid cells.
 *
 * The DataGrid is a read-only "Notion-style" surface: cells render as
 * presentational chips, thumbnails, and formatted values. Editing happens
 * in the row inspector (opened by clicking the row), not inline.
 *
 * Each field type maps to its own display variant. Empty / null values
 * render as a muted em-dash (`—`) so empty cells are visually distinct
 * from cells with values.
 *
 * Sibling: `CellEditorRenderer.tsx` is still used inside the inspector
 * (RowDetail) where every cell is an editable input.
 */
import type { ReactElement } from 'react'
import {
  readBooleanCell,
  readFieldSchemaCell,
  readNodeTreeCell,
  readSeoCell,
  readNumberCell,
  readStringArrayCell,
  readStringCell,
} from '@core/data/cells'
import type {
  DataField,
  DataRow,
  DataRowCells,
  DataTable,
} from '@core/data/schemas'
import { useMediaAssetMap } from '@admin/pages/data/hooks/useMediaAssetMap'
import { Image } from '@ui/components/Image'
import { ImageSolidIcon } from 'pixel-art-icons/icons/image-solid'
import { ImageXSolidIcon } from 'pixel-art-icons/icons/image-x-solid'
import { VideoSolidIcon } from 'pixel-art-icons/icons/video-solid'
import { LinkIcon } from 'pixel-art-icons/icons/link'
import { CheckIcon } from 'pixel-art-icons/icons/check'
import styles from './cells.module.css'

// ---------------------------------------------------------------------------
// Public props
// ---------------------------------------------------------------------------

interface CellDisplayProps {
  field: DataField
  cells: DataRowCells
  /** Full tables list — required for resolving relation target rows. */
  tables: DataTable[]
  /** All rows in the active table — used to resolve relation labels. */
  rows: DataRow[]
}

// ---------------------------------------------------------------------------
// Empty placeholder — used uniformly for every field type when the cell
// holds no meaningful value.
// ---------------------------------------------------------------------------

function Empty(): ReactElement {
  return <span className={styles.empty} aria-label="Empty">—</span>
}

// ---------------------------------------------------------------------------
// Number formatting — respects the field's format/currency/integer hints.
// ---------------------------------------------------------------------------

function formatNumber(value: number, field: Extract<DataField, { type: 'number' }>): string {
  const intOpts = field.integer === true
    ? { maximumFractionDigits: 0 } as const
    : {} as Intl.NumberFormatOptions
  try {
    if (field.format === 'currency') {
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: field.currency || 'USD',
        ...intOpts,
      }).format(value)
    }
    if (field.format === 'percent') {
      return new Intl.NumberFormat(undefined, {
        style: 'percent',
        ...intOpts,
      }).format(value)
    }
    return new Intl.NumberFormat(undefined, intOpts).format(value)
  } catch {
    return String(value)
  }
}

// ---------------------------------------------------------------------------
// Date / dateTime formatting
// ---------------------------------------------------------------------------

function formatDate(iso: string, withTime: boolean): string | null {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  if (withTime) {
    return d.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  }
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

// ---------------------------------------------------------------------------
// Plain-text preview for richText (best-effort strip of HTML / MD).
// ---------------------------------------------------------------------------

function richTextPreview(raw: string, format: 'markdown' | 'html'): string {
  if (format === 'html') {
    return raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  }
  return raw
    .replace(/^[#>*_~`-]+\s*/gm, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

// ---------------------------------------------------------------------------
// Sub-renderers per field type
// ---------------------------------------------------------------------------

function TextDisplay({ value }: { value: string }): ReactElement {
  if (value.trim().length === 0) return <Empty />
  return <span className={styles.text}>{value}</span>
}

function NumberDisplay({
  value,
  field,
}: {
  value: number | null
  field: Extract<DataField, { type: 'number' }>
}): ReactElement {
  if (value == null) return <Empty />
  return <span className={styles.numberValue}>{formatNumber(value, field)}</span>
}

function BooleanDisplay({ value }: { value: boolean }): ReactElement {
  if (value) {
    return (
      <span className={styles.boolTrue} aria-label="Yes">
        <CheckIcon size={12} aria-hidden="true" />
      </span>
    )
  }
  return <Empty />
}

function DateDisplay({ value, withTime }: { value: string | null; withTime: boolean }): ReactElement {
  if (value == null || value === '') return <Empty />
  const formatted = formatDate(value, withTime)
  if (formatted == null) return <Empty />
  return <span className={styles.text}>{formatted}</span>
}

function SelectDisplay({
  value,
  field,
}: {
  value: string | null
  field: Extract<DataField, { type: 'select' }>
}): ReactElement {
  if (value == null || value === '') return <Empty />
  const option = field.options.find((o) => o.id === value || o.value === value)
  if (!option) return <Empty />
  return (
    <span className={styles.chip} data-color={option.color ?? undefined}>
      {option.color && (
        <span className={styles.chipDot} style={{ background: option.color }} aria-hidden="true" />
      )}
      <span className={styles.chipLabel}>{option.label}</span>
    </span>
  )
}

function MultiSelectDisplay({
  values,
  field,
}: {
  values: string[]
  field: Extract<DataField, { type: 'multiSelect' }>
}): ReactElement {
  if (values.length === 0) return <Empty />
  const maxVisible = 2
  const visible = values.slice(0, maxVisible)
  const overflow = values.length - maxVisible
  return (
    <span className={styles.chipSet}>
      {visible.map((v) => {
        const option = field.options.find((o) => o.id === v || o.value === v)
        if (!option) return null
        return (
          <span
            key={option.id}
            className={styles.chip}
            data-tone="tag"
            data-color={option.color ?? undefined}
          >
            {option.color && (
              <span className={styles.chipDot} style={{ background: option.color }} aria-hidden="true" />
            )}
            <span className={styles.chipLabel}>{option.label}</span>
          </span>
        )
      })}
      {overflow > 0 && (
        <span className={styles.chip} data-tone="overflow">
          +{overflow}
        </span>
      )}
    </span>
  )
}

function UrlEmailDisplay({ value }: { value: string }): ReactElement {
  if (value.trim().length === 0) return <Empty />
  return <span className={styles.linkText}>{value}</span>
}

function MediaDisplay({
  ids,
}: {
  ids: string[]
}): ReactElement {
  const assetMap = useMediaAssetMap(ids)
  if (ids.length === 0) return <Empty />

  const firstId = ids[0]!
  const asset = assetMap.get(firstId)
  const extra = ids.length - 1

  // Thumbnail variant
  let thumb: ReactElement
  if (asset === undefined) {
    thumb = <span className={styles.mediaDisplayThumb} data-state="loading" aria-hidden="true" />
  } else if (asset === null) {
    thumb = (
      <span className={styles.mediaDisplayThumb} data-state="missing" aria-hidden="true">
        <ImageXSolidIcon size={10} />
      </span>
    )
  } else if (asset.mimeType.startsWith('image/')) {
    thumb = (
      <span className={styles.mediaDisplayThumb} data-state="image" aria-hidden="true">
        {/* 22×22 thumb — `sizes="22px"` keeps the browser on the
            smallest variant from the asset's srcset ladder. */}
        <Image
          asset={asset}
          alt={asset.altText || asset.filename}
          sizes="22px"
          className={styles.mediaDisplayThumbImg}
        />
      </span>
    )
  } else if (asset.mimeType.startsWith('video/')) {
    if (asset.posterPath) {
      thumb = (
        <span className={styles.mediaDisplayThumb} data-state="video" aria-hidden="true">
          {/* Video poster ships only as `posterPath` — no variant
              ladder — so degrade to a plain <Image src=…>. */}
          <Image
            src={asset.posterPath}
            alt={asset.filename}
            sizes="22px"
            className={styles.mediaDisplayThumbImg}
          />
        </span>
      )
    } else {
      thumb = (
        <span className={styles.mediaDisplayThumb} data-state="video" aria-hidden="true">
          <VideoSolidIcon size={10} />
        </span>
      )
    }
  } else {
    thumb = (
      <span className={styles.mediaDisplayThumb} data-state="file" aria-hidden="true">
        <ImageSolidIcon size={10} />
      </span>
    )
  }

  const filename = asset?.filename ?? firstId

  return (
    <span className={styles.mediaDisplay}>
      {thumb}
      <span className={styles.mediaDisplayName}>{filename}</span>
      {extra > 0 && <span className={styles.mediaDisplayOverflow}>+{extra}</span>}
    </span>
  )
}

function RelationDisplay({
  ids,
  field,
  tables,
  rows,
}: {
  ids: string[]
  field: Extract<DataField, { type: 'relation' }>
  tables: DataTable[]
  rows: DataRow[]
}): ReactElement {
  if (ids.length === 0) return <Empty />

  // Resolve target table for primary field id.
  const target = tables.find((t) => t.id === field.targetTableId)
  // For same-table relations we have `rows`. Cross-table resolution is
  // out of scope for this hook (would require an async fetch); we degrade
  // gracefully to showing the relation id.
  const targetRows = target?.id === field.targetTableId ? rows : []

  function labelFor(id: string): string {
    if (!target) return id
    const row = targetRows.find((r) => r.id === id)
    if (!row) return id
    const primaryValue = row.cells[target.primaryFieldId]
    return typeof primaryValue === 'string' && primaryValue.length > 0
      ? primaryValue
      : id
  }

  const isMulti = field.allowMultiple === true
  if (isMulti) {
    const maxVisible = 2
    const visible = ids.slice(0, maxVisible)
    const overflow = ids.length - maxVisible
    return (
      <span className={styles.chipSet}>
        {visible.map((id) => (
          <span key={id} className={styles.chip} data-tone="relation">
            <LinkIcon size={10} aria-hidden="true" />
            <span className={styles.chipLabel}>{labelFor(id)}</span>
          </span>
        ))}
        {overflow > 0 && (
          <span className={styles.chip} data-tone="overflow">+{overflow}</span>
        )}
      </span>
    )
  }

  return (
    <span className={styles.chip} data-tone="relation">
      <LinkIcon size={10} aria-hidden="true" />
      <span className={styles.chipLabel}>{labelFor(ids[0]!)}</span>
    </span>
  )
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export function CellDisplayRenderer({
  field,
  cells,
  tables,
  rows,
}: CellDisplayProps): ReactElement {
  switch (field.type) {
    case 'text': {
      return <TextDisplay value={readStringCell(cells, field.id)} />
    }
    case 'longText': {
      return <TextDisplay value={readStringCell(cells, field.id)} />
    }
    case 'richText': {
      const raw = readStringCell(cells, field.id)
      if (raw.trim().length === 0) return <Empty />
      return <span className={styles.text}>{richTextPreview(raw, field.format)}</span>
    }
    case 'number': {
      return <NumberDisplay value={readNumberCell(cells, field.id)} field={field} />
    }
    case 'boolean': {
      return <BooleanDisplay value={readBooleanCell(cells, field.id)} />
    }
    case 'date': {
      const raw = readStringCell(cells, field.id)
      return <DateDisplay value={raw || null} withTime={false} />
    }
    case 'dateTime': {
      const raw = readStringCell(cells, field.id)
      return <DateDisplay value={raw || null} withTime />
    }
    case 'select': {
      const raw = readStringCell(cells, field.id)
      return <SelectDisplay value={raw || null} field={field} />
    }
    case 'multiSelect': {
      return <MultiSelectDisplay values={readStringArrayCell(cells, field.id)} field={field} />
    }
    case 'url':
    case 'email': {
      return <UrlEmailDisplay value={readStringCell(cells, field.id)} />
    }
    case 'media': {
      const ids = field.allowMultiple === true
        ? readStringArrayCell(cells, field.id)
        : (() => {
            const v = cells[field.id]
            return typeof v === 'string' && v.length > 0 ? [v] : []
          })()
      return <MediaDisplay ids={ids} />
    }
    case 'relation': {
      const ids = field.allowMultiple === true
        ? readStringArrayCell(cells, field.id)
        : (() => {
            const v = cells[field.id]
            return typeof v === 'string' && v.length > 0 ? [v] : []
          })()
      return <RelationDisplay ids={ids} field={field} tables={tables} rows={rows} />
    }
    case 'pageTree': {
      const tree = readNodeTreeCell(cells, field.id)
      if (!tree) return <Empty />
      return <span className={styles.text}>Page tree</span>
    }
    case 'fieldSchema': {
      const params = readFieldSchemaCell(cells, field.id)
      if (params.length === 0) return <Empty />
      const label = params.length === 1 ? '1 param' : `${params.length} params`
      return <span className={styles.text}>{label}</span>
    }
    case 'seoMetadata': {
      const seo = readSeoCell(cells)
      if (!seo || Object.keys(seo).length === 0) return <Empty />
      return <span className={styles.text}>{seo.title ?? 'SEO set'}</span>
    }
    default: {
      const _exhaustive: never = field
      void _exhaustive
      return <Empty />
    }
  }
}
