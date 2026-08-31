/**
 * SvgControl — the property-panel control for a `base.svg` node's inline-SVG
 * markup. Mirrors the image-picker pattern: a live preview tile plus actions.
 *
 *   - Preview: the sanitised SVG rendered on a checkerboard tile (or an
 *     empty-state placeholder when there's no markup).
 *   - "Edit code": opens the markup in the shared draggable CodeMirror editor
 *     (HTML highlighting) — the same editor used for site files. Edits stream
 *     straight back to the node prop, so the preview + canvas update live.
 *   - "From library": opens the media picker filtered to images; picking an
 *     SVG file fetches its contents, sanitises them, and INLINES the markup
 *     into the prop (so it gains currentColor tinting / CSS styling / editing
 *     that a plain `<img src>` can't). Non-SVG picks are rejected.
 *   - "Icons": opens the icon picker and inlines the chosen glyph. Same
 *     destination as the other two — an icon on a page IS inline SVG, so it
 *     needs no module of its own.
 *   - "Clear": empties the markup.
 *
 * Editing happens in the real code editor rather than a cramped textarea so a
 * pasted logo / icon gets proper syntax highlighting, line numbers, and room.
 */
import { Suspense, lazy, useRef, useState } from 'react'
import type { ControlProps } from './shared'
import { useEditorStore } from '@site/store/store'
import { sanitizeSvg } from '@core/sanitize'
import type { CmsMediaAsset } from '@core/persistence/cmsMedia'
import { ControlRow } from '@ui/components/ControlRow'
import { Button } from '@ui/components/Button'
import { ImageSolidIcon } from 'pixel-art-icons/icons/image-solid'
import { CodeIcon } from 'pixel-art-icons/icons/code'
import { SparklesSolidIcon } from 'pixel-art-icons/icons/sparkles-solid'
import { IconPicker } from '@ui/components/IconPicker'
import styles from './controls.module.css'

// Lazy so the media-picker stack only loads when the user opens it.
const MediaPickerModal = lazy(() =>
  import('@admin/pages/media/components/MediaPickerModal/MediaPickerModal').then(
    (m) => ({ default: m.MediaPickerModal }),
  ),
)

const SVG_MIME = 'image/svg+xml'

export function SvgControl({
  propKey,
  value,
  onChange,
  label,
  isOverride,
  disabled,
  layout,
}: ControlProps<string>) {
  const selectedNodeId = useEditorStore((s) => s.selectedNodeId)
  const openPropInEditor = useEditorStore((s) => s.openPropInEditor)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [iconPickerOpen, setIconPickerOpen] = useState(false)
  // Anchor for the icon-picker FloatingPanel — it opens beside this button.
  const iconButtonRef = useRef<HTMLButtonElement>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const markup = sanitizeSvg(value)

  const openEditor = () => {
    if (!selectedNodeId) return
    openPropInEditor({ nodeId: selectedNodeId, propKey, title: 'Edit SVG', language: 'html' })
  }

  async function handlePick(asset: CmsMediaAsset) {
    setPickerOpen(false)
    if (asset.mimeType !== SVG_MIME) {
      setError('That file isn’t an SVG — pick a .svg file to inline.')
      return
    }
    setError('')
    setLoading(true)
    try {
      const res = await fetch(asset.publicPath)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const clean = sanitizeSvg(await res.text())
      if (!clean) {
        setError('Couldn’t read a valid SVG from that file.')
        return
      }
      onChange(propKey, clean)
    } catch (err) {
      console.error('[SvgControl] failed to load SVG from library:', err)
      setError('Couldn’t load that SVG file.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <ControlRow
      propKey={propKey}
      label={label}
      layout={layout}
      isOverride={isOverride}
      disabled={disabled}
    >
      <div className={styles.svgControl}>
        <div className={styles.svgPreview} data-empty={markup ? undefined : 'true'}>
          {markup ? (
            <span
              className={styles.svgPreviewInner}
              aria-hidden="true"
              dangerouslySetInnerHTML={{ __html: markup }}
            />
          ) : (
            <span className={styles.svgPreviewEmpty}>
              <ImageSolidIcon size={20} aria-hidden="true" />
              No SVG
            </span>
          )}
        </div>

        <div className={styles.svgActions}>
          <Button
            variant="secondary"
            size="sm"
            disabled={disabled || !selectedNodeId}
            onClick={openEditor}
          >
            <CodeIcon size={14} color="currentColor" />
            {markup ? 'Edit code' : 'Add SVG'}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={disabled || loading}
            onClick={() => { setError(''); setPickerOpen(true) }}
          >
            <ImageSolidIcon size={14} color="currentColor" />
            {loading ? 'Loading…' : 'From library'}
          </Button>
          <Button
            ref={iconButtonRef}
            variant="secondary"
            size="sm"
            disabled={disabled}
            onClick={() => { setError(''); setIconPickerOpen(true) }}
          >
            <SparklesSolidIcon size={14} color="currentColor" />
            Icons
          </Button>
          {markup ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled}
              onClick={() => onChange(propKey, '')}
            >
              Clear
            </Button>
          ) : null}
        </div>

        {error ? (
          <span className={styles.svgError} role="alert">{error}</span>
        ) : null}
      </div>

      <IconPicker
        open={iconPickerOpen}
        onClose={() => setIconPickerOpen(false)}
        anchorRef={iconButtonRef}
        onPick={(svgMarkup) => onChange(propKey, svgMarkup)}
      />

      {pickerOpen ? (
        <Suspense fallback={null}>
          <MediaPickerModal
            open={pickerOpen}
            onClose={() => setPickerOpen(false)}
            mediaKind="svg"
            onPick={handlePick}
          />
        </Suspense>
      ) : null}
    </ControlRow>
  )
}
