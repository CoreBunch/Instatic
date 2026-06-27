/**
 * SeoImageField — social-image picker for OG/X images and site-default
 * images.
 *
 * Same Library/URL pattern as the property panel's `MediaLibraryControl`:
 * a segmented source toggle over the shared `MediaPickerField` tile
 * (thumbnail + Change/Clear, fullscreen `MediaPickerModal`), or a plain URL
 * input with inline preview for externally-hosted images. Empty value falls
 * back through the resolver chain — the inherited image renders in the tile
 * with an "Inherited" hint until overridden.
 */
import { lazy, Suspense, useEffect, useState } from 'react'
import { Input } from '@ui/components/Input'
import { SegmentedControl } from '@ui/components/SegmentedControl'
import { listCmsMediaAssets, type CmsMediaAsset } from '@core/persistence/cmsMedia'
import { isValidImageUrl } from '@core/utils/urlValidation'
import { getErrorMessage } from '@core/utils/errorMessage'
import { MediaPickerField } from '@admin/pages/media/components/MediaPickerField'
import { SeoFormRow } from './SeoFormRow'
import styles from './SeoImageField.module.css'

const MediaPickerModal = lazy(() =>
  import('@admin/pages/media/components/MediaPickerModal/MediaPickerModal').then(
    (m) => ({ default: m.MediaPickerModal }),
  ),
)

type Mode = 'library' | 'url'

const SOURCE_OPTIONS = [
  { value: 'library', label: 'Library', ariaLabel: 'Media library' },
  { value: 'url', label: 'URL', ariaLabel: 'Custom URL' },
] satisfies ReadonlyArray<{ value: Mode; label: string; ariaLabel: string }>

interface SeoImageFieldProps {
  label: string
  /** Anchor id — the improvements list scrolls to / focuses this field. */
  fieldId?: string
  /** Explicit value ('' when inheriting). */
  value: string
  /** Resolved fallback shown when no explicit value is set. */
  inheritedValue: string | null
  disabled: boolean
  onChange: (next: string) => void
}

/** Local upload paths and absolute http(s)/data:image URLs are accepted. */
function isValidSeoImageValue(value: string): boolean {
  if (value === '') return true
  if (value.startsWith('/') && !value.startsWith('//')) return true
  return isValidImageUrl(value)
}

export function SeoImageField({ label, fieldId, value, inheritedValue, disabled, onChange }: SeoImageFieldProps) {
  const [mode, setMode] = useState<Mode>(() =>
    value !== '' && !value.startsWith('/uploads/') ? 'url' : 'library',
  )
  const [pickerOpen, setPickerOpen] = useState(false)
  // Fetched once so the picked tile can render the right thumbnail +
  // metadata for a saved publicPath — same approach as MediaLibraryControl.
  // The modal mounts its own workspace when opened.
  const [assets, setAssets] = useState<CmsMediaAsset[]>([])
  const [libraryError, setLibraryError] = useState('')

  useEffect(() => {
    let cancelled = false
    listCmsMediaAssets()
      .then((next) => {
        if (!cancelled) setAssets(next)
      })
      .catch((err: unknown) => {
        if (!cancelled) setLibraryError(getErrorMessage(err, 'Unable to load media library'))
      })
    return () => {
      cancelled = true
    }
  }, [])

  // The tile resolves a thumbnail only for the EXPLICIT value; a purely
  // inherited image renders through the fallback branch so the "Inherited"
  // hint stays visible.
  const asset = value !== '' ? assets.find((a) => a.publicPath === value) ?? null : null
  const inheriting = value === '' && inheritedValue !== null
  const urlInvalid = !isValidSeoImageValue(value)

  function handlePick(picked: CmsMediaAsset): void {
    setAssets((current) => (current.some((a) => a.id === picked.id) ? current : [picked, ...current]))
    onChange(picked.publicPath)
    setPickerOpen(false)
  }

  return (
    <SeoFormRow label={label} anchorId={fieldId}>
      <SegmentedControl<Mode>
          value={mode}
          options={SOURCE_OPTIONS}
          onChange={setMode}
          size="sm"
          fullWidth
          disabled={disabled}
          aria-label={`${label} source`}
        />

        {mode === 'library' ? (
          <>
            <MediaPickerField
              asset={asset}
              hasValue={value !== '' || inheriting}
              fallbackLabel={
                inheriting
                  ? inheritedValue.split('/').pop() ?? inheritedValue
                  : value.split('/').pop() ?? value
              }
              fallbackHint={inheriting ? 'Inherited — pick one to override' : 'Saved path'}
              mediaKind="image"
              subjectLabel={label}
              disabled={disabled}
              onBrowse={() => setPickerOpen(true)}
              onClear={value !== '' ? () => onChange('') : undefined}
            />
            {libraryError && (
              <p className={styles.status} role="alert">{libraryError}</p>
            )}
          </>
        ) : (
          <div className={styles.urlBody}>
            {value !== '' && !urlInvalid && (
              <span className={styles.urlPreview}>
                <img
                  src={value}
                  alt=""
                  loading="lazy"
                  onError={(event) => {
                    ;(event.target as HTMLImageElement).style.display = 'none'
                  }}
                />
              </span>
            )}
            <Input
              type="url"
              value={value}
              placeholder={inheritedValue ?? 'https://example.com/image.png'}
              disabled={disabled}
              invalid={urlInvalid}
              aria-label={`${label} URL`}
              onChange={(e) => onChange(e.target.value)}
            />
            {urlInvalid && (
              <p className={styles.status} role="alert">
                Must be an absolute http(s) URL or a local upload path.
              </p>
            )}
          </div>
        )}
      {pickerOpen && (
        <Suspense fallback={null}>
          <MediaPickerModal
            open={pickerOpen}
            onClose={() => setPickerOpen(false)}
            mediaKind="image"
            currentValue={value || null}
            onPick={handlePick}
          />
        </Suspense>
      )}
    </SeoFormRow>
  )
}
