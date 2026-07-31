/**
 * MediaLibraryControl — the property-panel control for `<img>` and `<video>`
 * `src` props. Two modes:
 *
 *   1. Library — the picked-media affordance is the shared
 *      `MediaPickerField` (tile + Change / Edit / Clear actions). Clicking
 *      "Change …" opens the fullscreen `MediaPickerModal` (folder tree +
 *      canvas grid + upload queue). Clicking the populated tile or the
 *      "Edit" button opens the `MediaViewerWindow` for editing alt text,
 *      caption, tags, replacing the file, etc.
 *
 *   2. URL — manual entry for external assets (CDN, third-party hosts).
 *      Plain `<Input type="url">` with a small inline preview.
 *
 * The sidebar property panel is ~280 px wide; cramming a full grid in here
 * is what made the previous picker unreadable. By delegating to the modal
 * we get the same wide canvas, folder tree, sort, and clear "selected"
 * affordance as the standalone Media page.
 */
import { Suspense, lazy, useEffect, useState } from 'react'
import {
  listCmsMediaAssets,
  type CmsMediaAsset,
} from '@core/persistence/cmsMedia'
import { isValidImageUrl } from '@core/utils/urlValidation'
import type { ControlProps } from './shared'
import { ControlRow } from '@ui/components/ControlRow'
import controlRowStyles from '@ui/components/ControlRow/ControlRow.module.css'
import { Input } from '@ui/components/Input'
import { SegmentedControl } from '@ui/components/SegmentedControl'
import { VideoSolidIcon } from 'pixel-art-icons/icons/video-solid'
import { MediaPickerField } from '@admin/pages/media/components/MediaPickerField'
import { MediaViewerWindow } from '@admin/pages/media/components/MediaViewerWindow/MediaViewerWindow'
import { useStandaloneMediaEditor } from '@admin/pages/media/hooks/useStandaloneMediaEditor'
import { primeCmsMediaAssetCache } from '@admin/pages/media/hooks/useCmsMediaAssetByPath'
import styles from './controls.module.css'
import { getErrorMessage } from '@core/utils/errorMessage'

// Lazy-load the modal so the entire MediaPage stack (folders / canvas /
// viewer / upload queue) doesn't ship in the eager admin-layouts chunk.
// The control surface itself is tiny — a thumbnail + a "Browse" button —
// so paying the modal's ~10 KB price only on first click is the right
// trade-off. Also lets the `layouts-*.js` bundle-size budget stay tight.
const MediaPickerModal = lazy(() =>
  import('@admin/pages/media/components/MediaPickerModal/MediaPickerModal').then(
    (m) => ({ default: m.MediaPickerModal }),
  ),
)

type MediaKind = 'image' | 'video'
type MediaMode = 'library' | 'url'

interface MediaLibraryControlProps extends ControlProps<string> {
  mediaKind: MediaKind
}

const MEDIA_SOURCE_OPTIONS = [
  { value: 'library', label: 'Library', ariaLabel: 'Media library' },
  { value: 'url', label: 'URL', ariaLabel: 'Custom URL' },
] satisfies ReadonlyArray<{ value: MediaMode; label: string; ariaLabel: string }>

function isLocalMediaPath(value: string): boolean {
  if (!value.startsWith('/') || value.startsWith('//')) return false
  for (const char of value) {
    const code = char.charCodeAt(0)
    if (char === '\\' || code <= 31) return false
  }
  return true
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value)
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}

function isValidMediaUrl(value: string, mediaKind: MediaKind): boolean {
  if (!value) return true
  if (isLocalMediaPath(value)) return true
  if (mediaKind === 'image') return isValidImageUrl(value)
  return isHttpUrl(value)
}

function startsInUrlMode(value: string): boolean {
  return Boolean(value) && !value.startsWith('/uploads/')
}

export function MediaLibraryControl({
  propKey,
  value,
  onChange,
  label,
  isOverride,
  disabled,
  layout,
  mediaKind,
}: MediaLibraryControlProps) {
  const currentValue = String(value ?? '')
  const [mode, setMode] = useState<MediaMode>(() => startsInUrlMode(currentValue) ? 'url' : 'library')
  const [pickerOpen, setPickerOpen] = useState(false)
  // We still fetch the asset list ONCE on mount so the "currently picked"
  // preview can show the right thumbnail + blurhash for the field's
  // saved publicPath. The modal mounts its own workspace when opened —
  // not used here.
  const [cmsAssets, setCmsAssets] = useState<CmsMediaAsset[]>([])
  const [libraryError, setLibraryError] = useState('')
  // Viewer state: when set, the MediaViewerWindow opens with this asset.
  // The viewer is the same draggable window the Media page uses, so the
  // user can edit alt text, caption, tags, replace the file, etc. — all
  // from inside the editor canvas without leaving the page.
  const [viewerAssetId, setViewerAssetId] = useState<string | null>(null)
  const [urlDraftState, setUrlDraftState] = useState(() => ({
    sourceValue: currentValue,
    draft: currentValue,
  }))

  // Not useAsyncResource: this is an optimistic collection, not a read-only
  // resource. `cmsAssets` is mutated in place after load — handlePickFromModal
  // prepends, and `viewerEditor` edits/removes existing rows via
  // onAssetChanged/onAssetRemoved — and the tag-autocomplete palette derives
  // from the live list. useAsyncResource's read-only `data` can't model that.
  useEffect(() => {
    let cancelled = false
    listCmsMediaAssets()
      .then((nextAssets) => {
        if (!cancelled) setCmsAssets(nextAssets)
      })
      .catch((err) => {
        if (!cancelled) {
          const message = getErrorMessage(err, 'Unable to load media library')
          setLibraryError(message === 'Unauthorized' ? 'Sign in again to use CMS media.' : message)
        }
      })
    return () => { cancelled = true }
  }, [])

  const modeLabel = mediaKind === 'image' ? 'image' : 'video'
  const validCurrentValue = isValidMediaUrl(currentValue, mediaKind)
  const currentAsset = cmsAssets.find((asset) => asset.publicPath === currentValue) ?? null
  const viewerAsset = cmsAssets.find((asset) => asset.id === viewerAssetId) ?? null
  // The viewer needs a `MediaAssetEditor` handle that wraps the same
  // mutations the Media page uses. We don't track folders here (the inspector
  // doesn't care which folder an asset lives in), but tag autocomplete still
  // works because the palette is derived from the loaded asset list.
  const viewerEditor = useStandaloneMediaEditor({
    asset: viewerAsset,
    assets: cmsAssets,
    onAssetChanged: (asset) =>
      setCmsAssets((current) => current.map((item) => item.id === asset.id ? asset : item)),
    onAssetRemoved: (id) => {
      setCmsAssets((current) => current.filter((item) => item.id !== id))
      if (viewerAssetId === id) setViewerAssetId(null)
    },
  })
  const showUrlPreview = validCurrentValue && currentValue
  const urlDraft = urlDraftState.sourceValue === currentValue ? urlDraftState.draft : currentValue
  const urlError = !isValidMediaUrl(urlDraft, mediaKind)

  function openViewer() {
    if (currentAsset) setViewerAssetId(currentAsset.id)
  }

  function handleUrlChange(event: React.ChangeEvent<HTMLInputElement>) {
    const nextValue = event.target.value
    const valid = isValidMediaUrl(nextValue, mediaKind)
    setUrlDraftState({ sourceValue: currentValue, draft: nextValue })
    if (valid) onChange(propKey, nextValue)
  }

  function handlePickFromModal(asset: CmsMediaAsset) {
    // Keep the local asset cache up to date so the "currently picked"
    // preview can render the right thumb without re-fetching.
    primeCmsMediaAssetCache(asset)
    setCmsAssets((current) => {
      if (current.some((a) => a.id === asset.id)) return current
      return [asset, ...current]
    })
    onChange(propKey, asset.publicPath)
  }

  function handleClear() {
    onChange(propKey, '')
  }

  // Fallback filename when we have a saved path but the asset row hasn't
  // matched yet (loading or deleted).
  const fallbackFilename = currentValue ? currentValue.split('/').pop() ?? currentValue : undefined

  return (
    <ControlRow
      propKey={propKey}
      label={label}
      inputId={`ctrl-${propKey}`}
      layout={layout}
      isOverride={isOverride}
      disabled={disabled}
      labelSuffix={mode === 'url' && urlError ? (
        <span className={controlRowStyles.labelError} role="alert">
          Invalid {modeLabel} URL
        </span>
      ) : undefined}
    >
      <div className={styles.mediaPicker}>
        <SegmentedControl<MediaMode>
          value={mode}
          options={MEDIA_SOURCE_OPTIONS}
          onChange={setMode}
          size="sm"
          fullWidth
          disabled={disabled}
          aria-label={`${label ?? propKey} source`}
        />

        {mode === 'library' ? (
          <>
            <MediaPickerField
              asset={currentAsset}
              hasValue={Boolean(currentValue)}
              fallbackLabel={fallbackFilename}
              fallbackHint="Saved path"
              mediaKind={mediaKind}
              subjectLabel={modeLabel}
              disabled={disabled}
              onBrowse={() => setPickerOpen(true)}
              onEdit={currentAsset ? openViewer : undefined}
              onClear={currentValue ? handleClear : undefined}
            />
            {libraryError && (
              <p className={styles.mediaStatus} role="alert">{libraryError}</p>
            )}
          </>
        ) : (
          <div className={styles.mediaUrlBody}>
            {showUrlPreview && mediaKind === 'image' && (
              <div className={styles.imagePreview}>
                <img
                  src={currentValue}
                  alt="preview"
                  className={styles.imagePreviewImg}
                  onError={(event) => {
                    ;(event.target as HTMLImageElement).style.display = 'none'
                  }}
                />
              </div>
            )}
            {showUrlPreview && mediaKind === 'video' && (
              <div className={styles.videoPreview} aria-hidden="true">
                <VideoSolidIcon size={16} />
                <span>{currentValue}</span>
              </div>
            )}
            <Input
              id={`ctrl-${propKey}`}
              type="url"
              value={urlDraft}
              placeholder={mediaKind === 'image' ? 'https://example.com/image.png' : 'https://example.com/video.mp4'}
              disabled={disabled}
              onChange={handleUrlChange}
              invalid={urlError}
            />
          </div>
        )}
      </div>

      {pickerOpen && (
        <Suspense fallback={null}>
          <MediaPickerModal
            open={pickerOpen}
            onClose={() => setPickerOpen(false)}
            mediaKind={mediaKind}
            currentValue={currentValue}
            onPick={handlePickFromModal}
          />
        </Suspense>
      )}

      <MediaViewerWindow
        editor={viewerEditor}
        open={viewerAsset !== null}
        onClose={() => setViewerAssetId(null)}
      />
    </ControlRow>
  )
}
