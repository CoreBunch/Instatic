/**
 * InsetBoxControl — the Position section's Inset editor
 * (docs/features/inspector-panel.md §6.2).
 *
 * The prototype does not give inset its own cross of four fields; it reuses
 * the Spacing section's vocabulary — the same box, the same faceted bands,
 * the same edge inputs — and swaps the middle. Where Spacing shows a core,
 * Inset shows a PINBOX: four bars, one per edge, that lock that edge's value.
 *
 * So this file shares `SpacingBoxControl.module.css` on purpose. The bands,
 * facets and side inputs are one look with two contents; giving inset its own
 * stylesheet is how the two would quietly drift apart.
 *
 * What a pin does: the value stays visible but stops accepting a caret, a
 * scrub or a step — that is what "pinned" means — and the canvas free-move
 * drag freezes the pinned edge's axis (useCanvasFreeMoveDrag). The lock is
 * editor-store state for the session (`lockedInsetSides`, reset when the
 * selection changes), not a stored property: CSS has nowhere to record "this
 * edge is locked", and inventing a key for it would put UI furniture in the
 * document.
 *
 * The pinbox core is the free-move indicator: lit while NO edge is pinned —
 * the element drags freely on the canvas — and clicking it clears every pin.
 *
 * Focusing an UNPINNED edge also opens the floating value editor
 * (ValueEditorPopout, §6.6) beside it, writing through the same
 * onChange/onPreview channels as inline typing.
 */

import { useId, useRef, useState } from 'react'
import type { CSSPropertyBag } from '@core/page-tree'
import { Button } from '@ui/components/Button'
import { useEditorStore } from '@site/store/store'
import type { InsetSide } from '@site/store/slices/selectionSlice'
import { TokenAwareInput } from '@site/property-controls/TokenAwareInput'
import { useSpacingTokens } from '@site/property-controls/tokenUtils'
import { beginSideScrub, sideDisplayChars } from './sideScrub'
import { PinBarGlyph } from '@ui/icons/inspectorGlyphs'
import { cn } from '@ui/cn'
import { hasStyleValue, stepCssLength } from '../styleValueUtils'
import { ValueEditorPopout } from './ValueEditorPopout'
import styles from './SpacingBoxControl.module.css'

const SIDES = [
  { side: 'top', property: 'top', axis: 'y' },
  { side: 'right', property: 'right', axis: 'x' },
  { side: 'bottom', property: 'bottom', axis: 'y' },
  { side: 'left', property: 'left', axis: 'x' },
] as const satisfies readonly { side: InsetSide; property: InsetSide; axis: 'x' | 'y' }[]

interface InsetBoxControlProps {
  storedStyles: Record<string, unknown>
  currentStyles: Record<string, unknown>
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onPreview?: (patch: Partial<CSSPropertyBag>) => void
  onClearPreview?: () => void
}

export function InsetBoxControl({
  storedStyles,
  currentStyles,
  onChange,
  onPreview,
  onClearPreview,
}: InsetBoxControlProps) {
  const tokens = useSpacingTokens()
  const locked = useEditorStore((state) => state.lockedInsetSides)
  const toggleInsetLock = useEditorStore((state) => state.toggleInsetLock)
  const clearInsetLocks = useEditorStore((state) => state.clearInsetLocks)
  const freeMove = locked.length === 0

  // ── Floating value editor (ValueEditorPopout) ──────────────────────────
  // One popout at a time, anchored beside the focused edge's input. A LOCKED
  // edge never opens it — a pin means "this value is held".
  const [editorSide, setEditorSide] = useState<InsetSide | null>(null)
  // Live draft from the popout OR a band scrub: previews on every move, and
  // the edge field shows that number as it happens instead of waiting for
  // release. Keyed by side — a scrub can run on an edge the popout isn't on.
  const [editorDraft, setEditorDraft] = useState<{ side: InsetSide; value: string } | null>(null)
  const editorAnchorRef = useRef<HTMLElement | null>(null)
  // Escape refocuses the anchor input, whose focus event would instantly
  // reopen the popout — suppress that one reopen.
  const suppressReopen = useRef(false)

  const closeEditor = () => {
    setEditorSide(null)
    setEditorDraft(null)
    suppressReopen.current = true
    setTimeout(() => {
      suppressReopen.current = false
    }, 0)
  }

  const openEditor = (side: InsetSide, anchor: HTMLElement | null) => {
    if (!anchor || suppressReopen.current) return
    editorAnchorRef.current = anchor
    setEditorSide(side)
  }

  const editorStored = editorSide ? storedStyles[editorSide] : undefined

  // Widest rendered left/right value — the side band follows it, same
  // mechanism as the spacing box (see --side-chars in the module CSS).
  const sideChars = Math.max(
    1,
    ...(['left', 'right'] as const).map((side) => {
      const draft = editorDraft?.side === side ? editorDraft.value : null
      const raw =
        draft ??
        (hasStyleValue(storedStyles[side])
          ? String(storedStyles[side])
          : hasStyleValue(currentStyles[side])
            ? String(currentStyles[side])
            : 'auto')
      return sideDisplayChars(raw, tokens)
    }),
  )

  return (
    <div className={styles.root}>
      <div
        className={cn(styles.box, styles['box--inset'])}
        // Dynamic custom property read back by the module CSS.
        style={{ '--side-chars': sideChars } as React.CSSProperties}
      >
        {SIDES.map(({ side, property }) => (
          <InsetSideInput
            key={side}
            side={side}
            property={property}
            stored={storedStyles[property]}
            current={currentStyles[property]}
            draft={editorDraft?.side === side ? editorDraft.value : null}
            onScrub={(event) => {
              if (locked.includes(side)) return
              beginSideScrub(event, {
                side,
                startRaw:
                  (hasStyleValue(storedStyles[property]) && String(storedStyles[property])) ||
                  (hasStyleValue(currentStyles[property]) && String(currentStyles[property])) ||
                  '',
                // Offsets pull past their edge — negative is normal here.
                allowNegative: true,
                onPreview: (resolved) => {
                  setEditorDraft({ side, value: resolved })
                  onPreview?.({ [property]: resolved } as Partial<CSSPropertyBag>)
                },
                onCommit: (resolved) => {
                  setEditorDraft(null)
                  onClearPreview?.()
                  onChange(property, resolved)
                },
                onCancel: () => {
                  setEditorDraft(null)
                  onClearPreview?.()
                },
              })
            }}
            locked={locked.includes(side)}
            tokens={tokens}
            onChange={onChange}
            onPreview={onPreview}
            onClearPreview={onClearPreview}
            onOpenEditor={(anchor) => openEditor(side, anchor)}
          />
        ))}

        <div className={styles.boxInner}>
          <div className={styles.pinbox}>
            {SIDES.map(({ side, axis }) => {
              const isLocked = locked.includes(side)
              return (
                <Button
                  key={side}
                  variant="ghost"
                  size="micro"
                  iconOnly
                  className={cn(styles.pin, styles[`pin--${side}`])}
                  aria-pressed={isLocked}
                  aria-label={`${isLocked ? 'Unpin' : 'Pin'} ${side} edge`}
                  tooltip={isLocked ? `Unpin ${side}` : `Pin ${side}`}
                  onClick={() => toggleInsetLock(side)}
                >
                  <PinBarGlyph axis={axis} />
                </Button>
              )
            })}
            {/* Free-move indicator: lit while no edge is pinned (the element
                drags freely on the canvas); clicking clears every pin. */}
            <Button
              variant="ghost"
              size="micro"
              iconOnly
              className={styles.pinCore}
              aria-pressed={freeMove}
              aria-label="Free move — drag the element on the canvas"
              tooltip="Free move — drag the element on the canvas"
              onClick={clearInsetLocks}
            />
          </div>
        </div>
      </div>

      {editorSide ? (
        <ValueEditorPopout
          // Keyed by side so switching edges remounts: drafts reset and the
          // FloatingPanel re-places beside the new anchor.
          key={editorSide}
          open
          onClose={closeEditor}
          anchorRef={editorAnchorRef}
          title={`Inset ${editorSide}`}
          value={hasStyleValue(editorStored) ? String(editorStored) : ''}
          allowAuto
          allowNegative
          tokens={tokens}
          onCommit={(resolved) => {
            setEditorDraft(null)
            onChange(editorSide, resolved)
          }}
          onPreview={(resolved) => {
            setEditorDraft({ side: editorSide, value: resolved ?? '' })
            onPreview?.({ [editorSide]: resolved ?? null } as Partial<CSSPropertyBag>)
          }}
          onClearPreview={() => {
            setEditorDraft(null)
            onClearPreview?.()
          }}
        />
      ) : null}
    </div>
  )
}

interface InsetSideInputProps {
  side: InsetSide
  property: 'top' | 'right' | 'bottom' | 'left'
  stored: unknown
  /** Live value-editor / scrub draft for this edge — wins over the stored value. */
  draft: string | null
  /** Pointer pressed the edge's band segment — may become a value scrub. */
  onScrub: (event: React.PointerEvent<HTMLElement>) => void
  current: unknown
  locked: boolean
  tokens: ReturnType<typeof useSpacingTokens>
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onPreview?: (patch: Partial<CSSPropertyBag>) => void
  onClearPreview?: () => void
  /** Open the floating value editor anchored to this edge's input element. */
  onOpenEditor: (anchor: HTMLElement | null) => void
}

function InsetSideInput({
  side,
  property,
  stored,
  current,
  draft,
  onScrub,
  locked,
  tokens,
  onChange,
  onPreview,
  onClearPreview,
  onOpenEditor,
}: InsetSideInputProps) {
  const inputId = useId()
  const isSet = hasStyleValue(stored)
  const storedValue = isSet ? String(stored) : ''
  const value = draft ?? storedValue
  // `auto` is what an unset offset actually resolves to, so it is the honest
  // placeholder — not `0`, which would claim the element is pinned to the edge.
  const placeholder = hasStyleValue(current) ? String(current) : 'auto'

  // Sibling of the label, not a child — the segment's trapezoid `clip-path`
  // would clip a grown value; see SpacingBoxControl's SideInput.
  return (
    <>
      <label
        htmlFor={inputId}
        className={cn(styles.segment, styles[`segment--${side}`])}
        data-state={isSet ? 'set' : 'unset'}
        data-locked={locked ? 'true' : undefined}
        onPointerDown={locked ? undefined : onScrub}
      />
      <TokenAwareInput
        id={inputId}
        value={value}
        placeholder={placeholder}
        tokens={tokens}
        fieldSize="xs"
        overlay
        tooltipOnOverflow
        hideTokenMenu
        readOnly={locked}
        aria-label={`Inset ${side}`}
        menuAriaLabel={`Inset ${side} spacing tokens`}
        inputClassName={cn(
          styles.sideInput,
          styles[`sideInput--${side}`],
          locked && styles.sideInputLocked,
        )}
        onCommit={(resolved) => {
          if (locked) return
          onChange(property, resolved)
        }}
        onFocus={() => {
          // A pinned edge is held — focusing it must not open the editor.
          if (locked) return
          onOpenEditor(document.getElementById(inputId))
        }}
        onStep={(delta) => {
          if (locked) return
          // Offsets go negative — pulling an element past its edge is normal.
          const next = stepCssLength(value || (placeholder === 'auto' ? '0px' : placeholder), delta, {
            min: Number.NEGATIVE_INFINITY,
          })
          if (next) onChange(property, next)
        }}
        onPreview={
          onPreview && !locked
            ? (resolved) => onPreview({ [property]: resolved ?? null } as Partial<CSSPropertyBag>)
            : undefined
        }
        onClearPreview={onClearPreview}
      />
    </>
  )
}
