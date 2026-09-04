/**
 * SpacingHighlightOverlay — live margin/padding visualization on the canvas.
 *
 * Two things switch it on, both session state in `selectionSlice`:
 *
 *   - `spacingHighlight` — while the inspector's Spacing box is being
 *     interacted with (side-input focus, band hover, or an open value-editor
 *     popout), the corresponding band(s) of the SELECTED element are tinted
 *     and a value chip floats over each with the used value in px — the
 *     Webflow-style "see what you're changing" affordance.
 *   - `spacingOverlayPinned` — the Spacing box's "show all spacing" pin: every
 *     margin and padding band of the selected element stays drawn, so the
 *     user can read an element's box model at a glance. Zero-width sides draw
 *     no band and (unlike the focused side) no chip either — eight "0" chips
 *     would just be noise.
 *
 * Geometry: margin bands sit OUTSIDE the border box, padding bands INSIDE it
 * (inset by the border widths). A NEGATIVE margin draws too — flipped to the
 * inside of the same edge (that is the space it swallowed) and tinted with
 * its own colour, so "pulled 20px up" never looks like "pushed 20px down".
 * A zero side draws no band, but a focused/hovered zero side still shows a
 * "0" chip at the edge midpoint so it stays legible.
 *
 * Liveness: preview writes (typing, slider drag, token hover) mutate styles
 * inside the iframe, so the RAF tick re-reads `getComputedStyle` + the
 * element rect every frame — but ONLY while something is on. When nothing is,
 * the component renders nothing and no loop runs: zero cost for normal canvas
 * work. Same portal / measure-session / READ-then-WRITE architecture as
 * `BreakpointSelectionOverlay`.
 */

import { useEffect, useEffectEvent, useRef } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@ui/cn'
import { useEditorStore } from '@site/store/store'
import type { InsetSide } from '@site/store/slices/selectionSlice'
import { CanvasNodeElementCache } from './canvasNodeLookup'
import { createCanvasOverlayMeasureSession } from './canvasOverlayGeometry'
import { hideOverlayElement, positionOverlayElement } from './canvasSelectionOverlayPositioning'
import { spacingBandRect, type SideWidths } from './spacingHighlightGeometry'
import styles from './SpacingHighlightOverlay.module.css'

type Box = 'margin' | 'padding'
const BOXES: readonly Box[] = ['margin', 'padding']
const SIDES: readonly InsetSide[] = ['top', 'right', 'bottom', 'left']

interface BandTarget {
  box: Box
  side: InsetSide
  /** Part of the live interaction (focused/hovered side), not just the pin. */
  focused: boolean
}

interface SpacingHighlightOverlayProps {
  /** The breakpoint frame's iframe — the selected element lives inside it. */
  iframeElement: HTMLIFrameElement | null
  /** Canvas root for the shared measure session (null → fixed fallback). */
  canvasRoot: HTMLElement | null
  /** Where bands + chips are portaled (canvas root, or body fallback). */
  portalTarget: HTMLElement
  /** Matches the selection overlay's scoped/fixed positioning contract. */
  mode: 'scoped' | 'fixed'
}

export function SpacingHighlightOverlay({
  iframeElement,
  canvasRoot,
  portalTarget,
  mode,
}: SpacingHighlightOverlayProps) {
  const highlight = useEditorStore((s) => s.spacingHighlight)
  const pinned = useEditorStore((s) => s.spacingOverlayPinned)
  const selectedNodeId = useEditorStore((s) => s.selectedNodeId)
  const layerRef = useRef<HTMLDivElement>(null)
  const elementCacheRef = useRef<CanvasNodeElementCache | null>(null)
  if (elementCacheRef.current === null) elementCacheRef.current = new CanvasNodeElementCache()

  // Pinned: every band of both boxes, with the live interaction (if any)
  // marked as focused. Otherwise only the interaction's sides.
  const targets: BandTarget[] = pinned
    ? BOXES.flatMap((box) =>
        SIDES.map((side) => ({
          box,
          side,
          focused: highlight?.box === box && highlight.sides.includes(side),
        })),
      )
    : (highlight?.sides.map((side) => ({ box: highlight.box, side, focused: true })) ?? [])

  const active = targets.length > 0 && selectedNodeId !== null

  // Reads the freshest targets/selection from the latest render closure —
  // the RAF effect below only re-arms when the loop should start/stop.
  const tickOnce = useEffectEvent((iframe: HTMLIFrameElement | null) => {
    const layer = layerRef.current
    if (!layer || targets.length === 0 || !selectedNodeId) return
    const iframeDoc = iframe?.contentDocument ?? null
    const win = iframeDoc?.defaultView ?? null
    const element =
      iframeDoc ? elementCacheRef.current!.resolve(iframeDoc, selectedNodeId) : null

    if (!iframe || !win || !element) {
      // Nothing measurable (iframe reloading, node unmounted) — hide all.
      for (const band of layer.querySelectorAll<HTMLElement>('[data-spacing-band]')) {
        hideOverlayElement(band)
      }
      for (const chip of layer.querySelectorAll<HTMLElement>('[data-spacing-chip]')) {
        chip.style.display = 'none'
      }
      return
    }

    // ── READ phase ──────────────────────────────────────────────────────
    const session = createCanvasOverlayMeasureSession(iframe, canvasRoot)
    const computed = win.getComputedStyle(element)
    const borderBox = element.getBoundingClientRect()
    const borders: SideWidths = {
      top: parseFloat(computed.borderTopWidth) || 0,
      right: parseFloat(computed.borderRightWidth) || 0,
      bottom: parseFloat(computed.borderBottomWidth) || 0,
      left: parseFloat(computed.borderLeftWidth) || 0,
    }
    const placements = targets.map(({ box, side, focused }) => {
      // Computed margin/padding is always the used length in px (`auto`
      // margins resolve to their used value); NaN-safe fallback covers
      // detached/edge cases.
      const value = parseFloat(computed.getPropertyValue(`${box}-${side}`)) || 0
      const rounded = Math.round(value)
      // Negative margins are drawn at their magnitude on the flipped side;
      // padding cannot be negative, so this only ever fires for margins.
      const negative = value < 0
      const thickness = Math.abs(value)
      const rect = session.measureRect(
        spacingBandRect(box, side, borderBox, thickness, borders, negative),
      )
      return {
        key: `${box}-${side}`,
        negative,
        label: rounded === 0 ? '0' : `${rounded}px`,
        bandRect: thickness > 0 ? rect : null,
        // A focused zero side keeps its "0" chip at the edge midpoint (the
        // band centre degenerates to it); a merely pinned zero side shows
        // nothing.
        showChip: focused || thickness > 0,
        chipX: Math.round(rect.x + rect.width / 2),
        chipY: Math.round(rect.y + rect.height / 2),
      }
    })

    // ── WRITE phase ─────────────────────────────────────────────────────
    for (const { key, negative, label, bandRect, showChip, chipX, chipY } of placements) {
      const band = layer.querySelector<HTMLElement>(`[data-spacing-band="${key}"]`)
      positionOverlayElement(band, bandRect)
      // The negative tint is a data attribute, not a class swap: the RAF tick
      // owns this element imperatively and the CSS keys off the attribute.
      if (band) {
        const flag = negative ? 'true' : null
        if (band.getAttribute('data-negative') !== flag) {
          if (flag) band.setAttribute('data-negative', flag)
          else band.removeAttribute('data-negative')
        }
      }
      const chip = layer.querySelector<HTMLElement>(`[data-spacing-chip="${key}"]`)
      if (!chip) continue
      if (!showChip) {
        if (chip.style.display !== 'none') chip.style.display = 'none'
        continue
      }
      const chipFlag = negative ? 'true' : null
      if (chip.getAttribute('data-negative') !== chipFlag) {
        if (chipFlag) chip.setAttribute('data-negative', chipFlag)
        else chip.removeAttribute('data-negative')
      }
      if (chip.textContent !== label) chip.textContent = label
      const transform = `translate(${chipX}px, ${chipY}px)`
      if (chip.style.transform !== transform) chip.style.transform = transform
      if (chip.style.display !== 'block') chip.style.display = 'block'
    }
  })

  useEffect(() => {
    if (!active) return

    let frame = 0
    let cancelled = false

    const tick = () => {
      if (cancelled) return
      tickOnce(iframeElement)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)

    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
    }
  }, [active, iframeElement])

  if (!active) return null

  return createPortal(
    <div
      ref={layerRef}
      className={styles.layer}
      data-canvas-spacing-overlay-mode={mode}
      aria-hidden="true"
    >
      {targets.map(({ box, side }) => (
        <div
          key={`band-${box}-${side}`}
          data-spacing-band={`${box}-${side}`}
          className={cn(styles.band, box === 'margin' ? styles.marginBand : styles.paddingBand)}
        />
      ))}
      {targets.map(({ box, side }) => (
        <div
          key={`chip-${box}-${side}`}
          data-spacing-chip={`${box}-${side}`}
          className={styles.chip}
        />
      ))}
    </div>,
    portalTarget,
  )
}
