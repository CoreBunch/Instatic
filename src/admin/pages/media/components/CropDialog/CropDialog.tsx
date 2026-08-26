/**
 * `CropDialog` — non-destructive crop editor for a raster media asset.
 *
 * One component, two entry points: the Media library viewer and the site
 * editor's image property panel. Both hand it an asset and get the updated
 * asset back, because the crop lives on the ASSET — cropping from either place
 * changes the image everywhere it is used, which is the same rule alt text
 * already follows.
 *
 * Two independent decisions share one stage:
 *
 *   - The CROP rectangle bakes pixels away. Drag it from anywhere inside,
 *     resize it from eight handles, or snap it to a ratio preset.
 *   - The FOCUS ellipse marks the subject. Its centre becomes
 *     `object-position` on the published page, so a slot that crops with
 *     `object-fit: cover` keeps the subject instead of the geometric middle.
 *
 * Only two small pucks inside the ellipse take pointer input — the ellipse
 * body is deliberately transparent to the pointer. It covers most of the
 * selection, and if it swallowed clicks the crop could only be dragged by its
 * edges, which is the exact bug this layout exists to avoid.
 *
 * The previews underneath COVER their slot, matching what the site does. A
 * contained preview would letterbox instead of cutting, and so would hide the
 * very edges the user is deciding about.
 *
 * Saving posts the rectangle; the server rebuilds the variant ladder from the
 * untouched original. Nothing here rewrites pixels, and "Reset" clears the
 * rectangle to restore the full frame.
 */
import { useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { Dialog } from '@ui/components/Dialog'
import { Button } from '@ui/components/Button'
import { pushToast } from '@ui/components/Toast'
import { getErrorMessage } from '@core/utils/errorMessage'
import { setCmsMediaAssetCrop, type CmsMediaAsset } from '@core/persistence/cmsMedia'
import {
  FULL_FRAME,
  applyRatio,
  clampFocusArea,
  clampRect,
  defaultFocusArea,
  focusAreaWithinCrop,
  isFullFrame,
  moveFocusArea,
  moveRect,
  previewStyle,
  resizeFocusArea,
  resizeRect,
  type CropHandle,
  type CropRect,
  type FocusArea,
} from './cropGeometry'
import styles from './CropDialog.module.css'

interface CropDialogProps {
  asset: CmsMediaAsset | null
  open: boolean
  onClose: () => void
  /** Called with the re-cropped asset (new variants, dimensions, blur hash). */
  onCropped: (asset: CmsMediaAsset) => void
}

const RATIOS: ReadonlyArray<{ id: string; label: string; ratio: number | null }> = [
  { id: 'free', label: 'Free', ratio: null },
  { id: 'square', label: '1:1', ratio: 1 },
  { id: 'portrait', label: '4:5', ratio: 4 / 5 },
  { id: 'photo', label: '3:2', ratio: 3 / 2 },
  { id: 'wide', label: '16:9', ratio: 16 / 9 },
]

/**
 * Preview slots, in the order a crop usually gets consumed: portrait card,
 * round/square tile, hero, wide banner. Each COVERS its slot, so what shows is
 * what the site would show — including what it cuts off.
 */
const PREVIEWS: ReadonlyArray<{ label: string; aspect: number }> = [
  { label: '3:4', aspect: 3 / 4 },
  { label: 'Square', aspect: 1 },
  { label: '16:9', aspect: 16 / 9 },
  { label: 'Panorama', aspect: 21 / 9 },
]

/**
 * The eight crop handles with the class and label each one needs. Kept as data
 * rather than eight near-identical JSX blocks — the only thing that varies is
 * which corner or edge it names.
 */
const HANDLES: ReadonlyArray<{ handle: CropHandle; className: string; label: string }> = [
  { handle: 'nw', className: styles.handleNw, label: 'Resize crop from the top left' },
  { handle: 'n', className: styles.handleN, label: 'Resize crop from the top edge' },
  { handle: 'ne', className: styles.handleNe, label: 'Resize crop from the top right' },
  { handle: 'e', className: styles.handleE, label: 'Resize crop from the right edge' },
  { handle: 'se', className: styles.handleSe, label: 'Resize crop from the bottom right' },
  { handle: 's', className: styles.handleS, label: 'Resize crop from the bottom edge' },
  { handle: 'sw', className: styles.handleSw, label: 'Resize crop from the bottom left' },
  { handle: 'w', className: styles.handleW, label: 'Resize crop from the left edge' },
]

/** Keyboard nudge, in frame fractions. Shift multiplies it for coarse moves. */
const NUDGE = 0.005
const NUDGE_COARSE = 0.05

const ARROW_DELTAS: Record<string, readonly [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
}

/**
 * Every drag carries the state it started from. Absolute pointer positions
 * would be enough for a corner handle (it sits exactly where the pointer
 * grabbed it), but not for the crop body or the focus pucks, which are grabbed
 * somewhere in their middle — reading those absolutely teleports the shape
 * under the cursor on the first frame.
 */
type DragState =
  | { kind: 'move'; startX: number; startY: number; origin: CropRect }
  | { kind: 'resize'; handle: CropHandle }
  | { kind: 'focusMove'; startX: number; startY: number; origin: FocusArea }
  | { kind: 'focusResize'; startX: number; startY: number; origin: FocusArea }

export function CropDialog({ asset, open, onClose, onCropped }: CropDialogProps) {
  const [rect, setRect] = useState<CropRect>(asset?.crop ?? FULL_FRAME)
  const [focus, setFocus] = useState<FocusArea | null>(asset?.focus ?? null)
  const [ratioId, setRatioId] = useState('free')
  const [saving, setSaving] = useState(false)
  const [loadedAssetId, setLoadedAssetId] = useState<string | null>(asset?.id ?? null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<DragState | null>(null)

  // Re-seed the rectangle when the dialog is pointed at a different asset.
  // Derived-state-during-render rather than an effect: the new asset's crop is
  // knowable at render time, and an effect would paint one frame of the
  // previous asset's rectangle over the new image.
  if (asset && asset.id !== loadedAssetId) {
    setLoadedAssetId(asset.id)
    setRect(asset.crop ?? FULL_FRAME)
    setFocus(asset.focus ?? null)
    setRatioId('free')
  }

  if (!asset) return null

  const imageAspect = asset.width && asset.height ? asset.width / asset.height : 1

  // The ellipse is always drawn, so an untouched asset still shows where the
  // focus WOULD be and can be grabbed. `focus` stays null until the user
  // actually drags it, and null is what gets saved — an image nobody framed
  // has no editorial focus, and should emit no `object-position` at all.
  const area = focus ?? defaultFocusArea(rect, imageAspect)

  /** Pointer position as a fraction of the rendered image box. */
  function pointerFraction(event: ReactPointerEvent): { x: number; y: number } {
    const box = stageRef.current?.getBoundingClientRect()
    if (!box || box.width === 0 || box.height === 0) return { x: 0, y: 0 }
    return {
      x: (event.clientX - box.left) / box.width,
      y: (event.clientY - box.top) / box.height,
    }
  }

  function beginDrag(event: ReactPointerEvent, state: DragState) {
    event.preventDefault()
    dragRef.current = state
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function beginMove(event: ReactPointerEvent) {
    const point = pointerFraction(event)
    beginDrag(event, { kind: 'move', startX: point.x, startY: point.y, origin: rect })
  }

  function beginResize(event: ReactPointerEvent, handle: CropHandle) {
    event.stopPropagation()
    beginDrag(event, { kind: 'resize', handle })
  }

  function beginFocusMove(event: ReactPointerEvent) {
    event.stopPropagation()
    const point = pointerFraction(event)
    beginDrag(event, { kind: 'focusMove', startX: point.x, startY: point.y, origin: area })
  }

  function beginFocusResize(event: ReactPointerEvent) {
    event.stopPropagation()
    const point = pointerFraction(event)
    beginDrag(event, { kind: 'focusResize', startX: point.x, startY: point.y, origin: area })
  }

  function handlePointerMove(event: ReactPointerEvent) {
    const drag = dragRef.current
    if (!drag) return
    const point = pointerFraction(event)

    if (drag.kind === 'focusMove') {
      setFocus(moveFocusArea(drag.origin, point.x - drag.startX, point.y - drag.startY, rect))
      return
    }

    if (drag.kind === 'focusResize') {
      setFocus(resizeFocusArea(drag.origin, point.x - drag.startX, point.y - drag.startY, rect))
      return
    }

    if (drag.kind === 'move') {
      const moved = moveRect(drag.origin, point.x - drag.startX, point.y - drag.startY)
      setRect(moved)
      // The focus rides along with the rectangle it was placed in — otherwise
      // dragging the crop would silently re-aim the focus at a different part
      // of the subject.
      if (focus) setFocus(clampFocusArea(focus, moved))
      return
    }

    const ratio = RATIOS.find((r) => r.id === ratioId)?.ratio ?? null
    const resized = resizeRect(rect, drag.handle, point.x, point.y)
    // A locked ratio re-snaps on every move so the selection can't drift off
    // its ratio while being dragged.
    const next = ratio === null ? resized : applyRatio(resized, ratio, imageAspect)
    setRect(next)
    if (focus) setFocus(clampFocusArea(focus, next))
  }

  function endDrag(event: ReactPointerEvent) {
    if (!dragRef.current) return
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  /** Arrow keys nudge the crop; Shift makes the step coarse. */
  function handleSelectionKeyDown(event: ReactKeyboardEvent) {
    const delta = ARROW_DELTAS[event.key]
    if (!delta) return
    event.preventDefault()
    const step = event.shiftKey ? NUDGE_COARSE : NUDGE
    const moved = moveRect(rect, delta[0] * step, delta[1] * step)
    setRect(moved)
    if (focus) setFocus(clampFocusArea(focus, moved))
  }

  /** Same for the focus ellipse, so framing is reachable without a pointer. */
  function handleFocusKeyDown(event: ReactKeyboardEvent) {
    const delta = ARROW_DELTAS[event.key]
    if (!delta) return
    event.preventDefault()
    const step = event.shiftKey ? NUDGE_COARSE : NUDGE
    setFocus(moveFocusArea(area, delta[0] * step, delta[1] * step, rect))
  }

  /** Shift+arrows on the rim handle grow or shrink the ellipse. */
  function handleFocusResizeKeyDown(event: ReactKeyboardEvent) {
    const delta = ARROW_DELTAS[event.key]
    if (!delta) return
    event.preventDefault()
    const step = event.shiftKey ? NUDGE_COARSE : NUDGE
    setFocus(resizeFocusArea(area, delta[0] * step, delta[1] * step, rect))
  }

  function chooseRatio(id: string, ratio: number | null) {
    setRatioId(id)
    if (ratio === null) return
    const next = applyRatio(rect, ratio, imageAspect)
    setRect(next)
    if (focus) setFocus(clampFocusArea(focus, next))
  }

  async function save(next: CropRect | null, nextFocus: FocusArea | null = focus) {
    if (!asset) return
    setSaving(true)
    try {
      const updated = await setCmsMediaAssetCrop(asset.id, next, nextFocus)
      onCropped(updated)
      onClose()
    } catch (err) {
      console.error('[CropDialog] crop failed:', err)
      pushToast({
        kind: 'error',
        title: 'Could not crop the image',
        body: getErrorMessage(err, 'Unknown crop error'),
      })
    } finally {
      setSaving(false)
    }
  }

  const selectionVars = {
    '--crop-x': rect.x,
    '--crop-y': rect.y,
    '--crop-w': rect.width,
    '--crop-h': rect.height,
  } as CSSProperties

  // The ellipse is positioned in IMAGE space (the stage), not inside the
  // selection, because that is the space it is stored in — no conversion, and
  // no chance of the overlay and the saved value disagreeing.
  const focusVars = {
    '--focus-left': area.x - area.width / 2,
    '--focus-top': area.y - area.height / 2,
    '--focus-w': area.width,
    '--focus-h': area.height,
  } as CSSProperties

  // Previews work in CROP space instead: their box shows the cropped frame, so
  // that is where the focal point has to be re-expressed.
  const focusInCrop = focusAreaWithinCrop(area, rect)
  const previewFocusVars = {
    '--focus-x': focusInCrop.x,
    '--focus-y': focusInCrop.y,
  } as CSSProperties

  return (
    <Dialog
      open={open}
      onClose={onClose}
      eyebrow="Media"
      title={`Crop ${asset.filename}`}
      size="2xl"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="secondary"
            onClick={() => void save(null, null)}
            disabled={saving || (!asset.crop && !asset.focus && isFullFrame(rect))}
          >
            Reset to full frame
          </Button>
          <Button
            variant="primary"
            onClick={() => void save(isFullFrame(rect) ? null : clampRect(rect))}
            disabled={saving}
          >
            {saving ? 'Applying…' : 'Apply crop'}
          </Button>
        </>
      }
    >
      <div className={styles.body}>
        <div className={styles.stage}>
          <div
            className={styles.stageInner}
            ref={stageRef}
            onPointerMove={handlePointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            <img
              className={styles.stageImage}
              src={asset.publicPath}
              alt={asset.altText || asset.filename}
              draggable={false}
            />

            <div
              className={styles.selection}
              style={selectionVars}
              onPointerDown={beginMove}
              onKeyDown={handleSelectionKeyDown}
              role="group"
              aria-label="Crop area — arrow keys move it"
              tabIndex={0}
            >
              {HANDLES.map(({ handle, className, label }) => (
                <button
                  key={handle}
                  type="button"
                  aria-label={label}
                  className={`${styles.handle} ${className}`}
                  onPointerDown={(event) => beginResize(event, handle)}
                />
              ))}
            </div>

            {/*
              Sibling of the selection, not a child: it paints above the
              selection's dimming shadow, and its own `pointer-events: none`
              keeps the crop draggable straight through it.
            */}
            <div className={styles.focusArea} style={focusVars}>
              <button
                type="button"
                className={styles.focusPuck}
                aria-label="Move the focal point — arrow keys nudge it"
                onPointerDown={beginFocusMove}
                onKeyDown={handleFocusKeyDown}
              />
              <button
                type="button"
                className={styles.focusHandle}
                aria-label="Resize the focus area — arrow keys resize it"
                onPointerDown={beginFocusResize}
                onKeyDown={handleFocusResizeKeyDown}
              />
            </div>
          </div>
        </div>

        <div className={styles.controls}>
          <div className={styles.ratios}>
            {RATIOS.map((option) => (
              <Button
                key={option.id}
                size="sm"
                variant={option.id === ratioId ? 'primary' : 'secondary'}
                onClick={() => chooseRatio(option.id, option.ratio)}
              >
                {option.label}
              </Button>
            ))}
          </div>
          <p className={styles.hint}>
            {asset.width && asset.height
              ? `Crop area: ${Math.round(rect.width * asset.width)} × ${Math.round(rect.height * asset.height)} px`
              : 'Drag inside the selection to move it, or grab a handle to resize'}
          </p>
        </div>

        <div className={styles.previews}>
          {PREVIEWS.map((preview) => {
            const style = previewStyle(rect, imageAspect, preview.aspect, focusInCrop)
            const vars = {
              ...previewFocusVars,
              '--preview-aspect': String(preview.aspect),
              '--preview-image': `url("${asset.publicPath}")`,
              '--preview-size': style.size,
              '--preview-position': style.position,
              '--preview-inner-w': style.innerWidth,
              '--preview-inner-h': style.innerHeight,
              '--preview-offset-x': style.offsetX,
              '--preview-offset-y': style.offsetY,
            } as CSSProperties
            return (
              <div className={styles.preview} key={preview.label}>
                <div className={styles.previewBox} style={vars}>
                  <div className={styles.previewInner}>
                    <span className={styles.previewFocus} />
                  </div>
                </div>
                <span className={styles.previewLabel}>{preview.label}</span>
              </div>
            )
          })}
        </div>

      </div>
    </Dialog>
  )
}
