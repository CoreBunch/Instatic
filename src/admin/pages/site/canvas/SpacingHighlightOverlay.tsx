/**
 * SpacingHighlightOverlay — live margin/padding visualization on the canvas.
 *
 * While the inspector's Spacing box is being interacted with (side-input
 * focus, band hover, or an open value-editor popout — `spacingHighlight` in
 * `selectionSlice`), this overlay tints the corresponding spacing band(s) of
 * the SELECTED element and floats a value chip over each band with the used
 * value in px — the Webflow-style "see what you're changing" affordance.
 *
 * Geometry: margin bands sit OUTSIDE the border box, padding bands INSIDE it
 * (inset by the border widths). A NEGATIVE margin draws too — flipped to the
 * inside of the same edge (that is the space it swallowed) and tinted with
 * its own colour, so "pulled 20px up" never looks like "pushed 20px down".
 * A zero side draws no band, but its chip still shows "0" at the edge
 * midpoint so the focused side stays legible.
 *
 * Liveness: preview writes (typing, slider drag, token hover) mutate styles
 * inside the iframe, so the RAF tick re-reads `getComputedStyle` + the
 * element rect every frame — but ONLY while a highlight is active. When
 * `spacingHighlight` is null the component renders nothing and no loop runs:
 * zero cost for normal canvas work. Same portal / measure-session / READ-then-
 * WRITE architecture as `BreakpointSelectionOverlay`.
 */

import { useEffect, useEffectEvent, useRef } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@ui/cn'
import { useEditorStore } from '@site/store/store'
import { CanvasNodeElementCache } from './canvasNodeLookup'
import { createCanvasOverlayMeasureSession } from './canvasOverlayGeometry'
import { hideOverlayElement, positionOverlayElement } from './canvasSelectionOverlayPositioning'
import { spacingBandRect, type SideWidths } from './spacingHighlightGeometry'
import styles from './SpacingHighlightOverlay.module.css'

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
  const selectedNodeId = useEditorStore((s) => s.selectedNodeId)
  const layerRef = useRef<HTMLDivElement>(null)
  const elementCacheRef = useRef<CanvasNodeElementCache | null>(null)
  if (elementCacheRef.current === null) elementCacheRef.current = new CanvasNodeElementCache()

  const active = Boolean(highlight && selectedNodeId)

  // Reads the freshest highlight/selection from the latest render closure —
  // the RAF effect below only re-arms when the loop should start/stop.
  const tickOnce = useEffectEvent((iframe: HTMLIFrameElement | null) => {
    const layer = layerRef.current
    if (!layer || !highlight || !selectedNodeId) return
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
    const placements = highlight.sides.map((side) => {
      // Computed margin/padding is always the used length in px (`auto`
      // margins resolve to their used value); NaN-safe fallback covers
      // detached/edge cases.
      const value = parseFloat(computed.getPropertyValue(`${highlight.box}-${side}`)) || 0
      const rounded = Math.round(value)
      // Negative margins are drawn at their magnitude on the flipped side;
      // padding cannot be negative, so this only ever fires for margins.
      const negative = value < 0
      const thickness = Math.abs(value)
      const rect = session.measureRect(
        spacingBandRect(highlight.box, side, borderBox, thickness, borders, negative),
      )
      return {
        side,
        negative,
        label: rounded === 0 ? '0' : `${rounded}px`,
        bandRect: thickness > 0 ? rect : null,
        // Chip anchors to the band centre — for a zero side that degenerates
        // to the edge midpoint, so "0" still has a home.
        chipX: Math.round(rect.x + rect.width / 2),
        chipY: Math.round(rect.y + rect.height / 2),
      }
    })

    // ── WRITE phase ─────────────────────────────────────────────────────
    for (const { side, negative, label, bandRect, chipX, chipY } of placements) {
      const band = layer.querySelector<HTMLElement>(`[data-spacing-band="${side}"]`)
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
      const chip = layer.querySelector<HTMLElement>(`[data-spacing-chip="${side}"]`)
      if (!chip) continue
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

  if (!active || !highlight) return null

  return createPortal(
    <div
      ref={layerRef}
      className={styles.layer}
      data-canvas-spacing-overlay-mode={mode}
      aria-hidden="true"
    >
      {highlight.sides.map((side) => (
        <div
          key={`band-${side}`}
          data-spacing-band={side}
          className={cn(
            styles.band,
            highlight.box === 'margin' ? styles.marginBand : styles.paddingBand,
          )}
        />
      ))}
      {highlight.sides.map((side) => (
        <div key={`chip-${side}`} data-spacing-chip={side} className={styles.chip} />
      ))}
    </div>,
    portalTarget,
  )
}
