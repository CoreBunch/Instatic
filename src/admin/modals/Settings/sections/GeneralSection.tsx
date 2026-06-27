/**
 * GeneralSection — site-level metadata.
 *
 * Fields: site name, meta title, meta description, language, favicon (picked
 * from the CMS media library — the same modal Content / Site property
 * controls use). All changes are persisted immediately to the Zustand store
 * and ultimately to the CMS draft via the autosave pipeline.
 *
 * Inputs use onBlur + onKeyDown(Enter) so intermediate keystrokes don't
 * push undo-history entries on every keystroke (performance pattern). The
 * favicon doesn't have intermediate states (single click → commit), so it
 * skips that pattern.
 */
import { Suspense, lazy, useState } from 'react'
import { useSiteSettingsController } from '../useSiteSettingsController'
import { useAsyncResource } from '@admin/lib/useAsyncResource'
import { Input } from '@ui/components/Input'
import { Button } from '@ui/components/Button'
import { SkeletonBlock } from '@ui/components/Skeleton'
import { ImagesSolidIcon } from 'pixel-art-icons/icons/images-solid'
import {
  listCmsMediaAssets,
  type CmsMediaAsset,
} from '@core/persistence/cmsMedia'
import { blurHashToDataUrl, pickVariantUrl } from '@admin/pages/media/utils/variants'
import s from '../SettingsModal.module.css'

// Lazy-load the media picker modal so the Settings modal opens quickly even
// when the Media-page module graph (folders / canvas / viewer) hasn't been
// loaded yet. The Settings modal is the only entry point that mounts this
// picker outside the property panel — paying the ~10 KB price only when the
// favicon row is touched keeps Settings cheap to open.
const MediaPickerModal = lazy(() =>
  import('@admin/pages/media/components/MediaPickerModal/MediaPickerModal').then(
    (m) => ({ default: m.MediaPickerModal }),
  ),
)

export function GeneralSection() {
  const { site, error, updateSiteName, updateSiteSettings } = useSiteSettingsController()

  if (error) {
    return <p className={s.sectionDescription} role="alert">{error}</p>
  }

  if (!site) {
    return <SkeletonBlock minHeight={200} ariaLabel="Loading site settings" />
  }

  const { settings } = site

  return (
    <div>
      <p className={s.sectionDescription}>
        Site name and HTML metadata used by the published CMS pages.
      </p>

      {/* ── Site name ─────────────────────────────────────────────────────── */}
      <div className={s.genFieldRow}>
        <label htmlFor="gen-proj-name" className={s.label}>
          Site Name
        </label>
        <Input
          id="gen-proj-name"
          type="text"
          defaultValue={site.name}
          onBlur={(e) => {
            const v = e.target.value.trim()
            if (v) updateSiteName(v)
          }}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
      </div>

      {/* ── Language ──────────────────────────────────────────────────────── */}
      <div className={s.genFieldRow}>
        <label htmlFor="gen-lang" className={s.label}>
          Language
        </label>
        <Input
          id="gen-lang"
          type="text"
          defaultValue={settings.language ?? 'en'}
          placeholder="en"
          onBlur={(e) =>
            updateSiteSettings({ language: e.target.value.trim() || 'en' })
          }
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
      </div>

      {/* ── Favicon ───────────────────────────────────────────────────────── */}
      <FaviconField
        currentValue={settings.faviconUrl ?? ''}
        onChange={(next) =>
          updateSiteSettings({ faviconUrl: next.trim() || undefined })
        }
      />
    </div>
  )
}

interface FaviconFieldProps {
  currentValue: string
  onChange: (next: string) => void
}

/**
 * Library-only favicon picker. Mirrors the property-panel
 * `MediaLibraryControl` "library" mode but without the URL-mode toggle:
 * the favicon always points at an asset hosted by the CMS so the file
 * lives next to all other site uploads, gets the same backup / replace /
 * sharing semantics, and never depends on a third-party host.
 */
function FaviconField({ currentValue, onChange }: FaviconFieldProps) {
  const [pickerOpen, setPickerOpen] = useState(false)

  // Single fetch of the asset list so the "currently picked" tile can show the
  // right thumbnail + filename for the saved publicPath. The modal mounts its
  // own workspace when opened; this resource only backs the inline preview.
  const { data: cmsAssets, error } = useAsyncResource<CmsMediaAsset[]>(
    () => listCmsMediaAssets(),
    [],
    { fallbackError: 'Unable to load media library' },
  )
  const libraryError = error === 'Unauthorized' ? 'Sign in again to use CMS media.' : error

  // A just-picked asset may post-date the loaded snapshot (e.g. uploaded inside
  // the modal), so keep it alongside the read-only resource to render its
  // thumbnail immediately without re-fetching the whole library.
  const [pickedAsset, setPickedAsset] = useState<CmsMediaAsset | null>(null)

  const currentAsset =
    (cmsAssets ?? []).find((asset) => asset.publicPath === currentValue) ??
    (pickedAsset?.publicPath === currentValue ? pickedAsset : null)

  function handlePickFromModal(asset: CmsMediaAsset) {
    setPickedAsset(asset)
    onChange(asset.publicPath)
  }

  return (
    <div className={s.genFieldRow}>
      <span className={s.label}>Favicon</span>
      <FaviconPreview asset={currentAsset} currentValue={currentValue} />
      <div className={s.faviconActions}>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setPickerOpen(true)}
          aria-label="Browse media library for favicon"
        >
          <ImagesSolidIcon size={13} />
          <span>{currentValue ? 'Change favicon' : 'Browse library…'}</span>
        </Button>
        {currentValue && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onChange('')}
            aria-label="Clear favicon"
          >
            Clear
          </Button>
        )}
      </div>
      {libraryError && (
        <p className={s.faviconStatus} role="alert">{libraryError}</p>
      )}

      {pickerOpen && (
        <Suspense fallback={null}>
          <MediaPickerModal
            open={pickerOpen}
            onClose={() => setPickerOpen(false)}
            mediaKind="image"
            currentValue={currentValue || null}
            onPick={handlePickFromModal}
          />
        </Suspense>
      )}
    </div>
  )
}

interface FaviconPreviewProps {
  asset: CmsMediaAsset | null
  currentValue: string
}

/**
 * Three states for the currently-saved favicon:
 *   1. asset matched in the library → real thumb + filename
 *   2. publicPath saved but no matching asset yet (loading / replaced
 *      asset) → render the raw path so authors can see what's saved
 *   3. nothing saved → empty hint
 */
function FaviconPreview({ asset, currentValue }: FaviconPreviewProps) {
  if (!asset && !currentValue) {
    return (
      <div className={s.faviconEmpty}>
        <span className={s.faviconEmptyIcon} aria-hidden="true">
          <ImagesSolidIcon size={18} />
        </span>
        <span>No favicon selected</span>
      </div>
    )
  }

  if (!asset) {
    const filename = currentValue.split('/').pop() ?? currentValue
    return (
      <div className={s.faviconCurrent}>
        <span className={s.faviconThumb} aria-hidden="true">
          <ImagesSolidIcon size={18} />
        </span>
        <span className={s.faviconMeta}>
          <span className={s.faviconName}>{filename}</span>
          <span className={s.faviconSub}>Saved path</span>
        </span>
      </div>
    )
  }

  const thumbUrl = pickVariantUrl(asset, 48)
  const blurUrl = blurHashToDataUrl(asset.blurHash)
  const thumbStyle = blurUrl
    ? ({ backgroundImage: `url(${blurUrl})`, backgroundSize: 'cover' } as React.CSSProperties)
    : undefined
  const dimensions = asset.width && asset.height ? `${asset.width} × ${asset.height}` : null
  const subParts = [asset.mimeType, dimensions].filter(Boolean).join(' · ')

  return (
    <div className={s.faviconCurrent}>
      <span className={s.faviconThumb} aria-hidden="true" style={thumbStyle}>
        {thumbUrl ? (
          <img src={thumbUrl} alt="" loading="lazy" decoding="async" />
        ) : (
          <ImagesSolidIcon size={18} />
        )}
      </span>
      <span className={s.faviconMeta}>
        <span className={s.faviconName}>{asset.filename}</span>
        {subParts && <span className={s.faviconSub}>{subParts}</span>}
      </span>
    </div>
  )
}
