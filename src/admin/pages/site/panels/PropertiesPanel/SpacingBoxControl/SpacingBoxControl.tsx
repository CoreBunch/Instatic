/**
 * SpacingBoxControl — visual box-model editor for padding & margin.
 *
 * Replaces the verbose 10-row stack (padding, paddingTop/Right/Bottom/Left,
 * margin, marginTop/Right/Bottom/Left) with the prototype's `.spacebox`:
 * two nested, borderless bands over a field-like core.
 *
 *   ┌──── MARGIN ──────────────────────────┐
 *   │                 24                    │
 *   │    ┌──── PADDING ───────────────┐     │
 *   │ 24 │ 16  ┌──────────────┐   16  │ 24  │
 *   │    │     └──────────────┘       │     │
 *   │    │             16             │     │
 *   │    └────────────────────────────┘     │
 *   │                 24                    │
 *   └───────────────────────────────────────┘
 *
 * Nothing is drawn: the margin band, the padding band and the core are three
 * steps on the surface scale, and each side's hit zone is a trapezoid whose
 * bevel is its own fill. Band thickness is absolute, so the widget's height
 * follows the core and the top and bottom bands always measure the same.
 *
 * Each side input is token-aware: typing `m` (or any step label) auto-
 * completes to the matching framework spacing variable (`var(--space-m)`).
 * Each box starts split while empty so the first edit touches only the
 * focused side. The link button explicitly syncs the focused side across
 * all four sides and then keeps future edits linked until the user unlinks.
 *
 * Focusing a side also opens the floating value editor (ValueEditorPopout)
 * beside it — slider, unit select, preset chips, reset — which writes through
 * the same commit/preview channels as inline typing, so linked mode fans out
 * identically.
 *
 * Storage model:
 *   - The control owns paddingTop/Right/Bottom/Left and marginTop/Right/
 *     Bottom/Left as the source of truth.
 *   - There is no shorthand `padding` / `margin` key in storage — that
 *     ambiguity is removed at the schema level. The publisher collapses
 *     the 4 sides into the CSS shorthand (`padding: 20px 0;`) at emission
 *     time (see `bagToCSS` in `core/publisher/classCss.ts`).
 */

import { useEffect, useId, useRef, useState } from 'react'
import type { CSSPropertyBag } from '@core/page-tree'
import { useEditorStore } from '@site/store/store'
import { cn } from '@ui/cn'
import { TokenAwareInput } from '@site/property-controls/TokenAwareInput'
import { useSpacingTokens, type Token } from '@site/property-controls/tokenUtils'
import { ValueEditorPopout } from './ValueEditorPopout'
import { SpacingBoxHeader } from './SpacingBoxHeader'
import { beginSideScrub, sideDisplayChars } from './sideScrub'
import styles from './SpacingBoxControl.module.css'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

const SIDES = ['top', 'right', 'bottom', 'left'] as const
type Side = (typeof SIDES)[number]
type Box = 'padding' | 'margin'

interface SpacingBoxControlProps {
  /** Stored values at the active breakpoint (no inherited base merge). */
  storedStyles: Record<string, unknown>
  /** Effective values including base-breakpoint inheritance — used for placeholders. */
  currentStyles: Record<string, unknown>
  onChange: (
    property: keyof CSSPropertyBag,
    value: string | number | undefined,
  ) => void
  onRemove: (property: keyof CSSPropertyBag) => void
  /**
   * Apply a transient style preview while a user hovers a token
   * suggestion. The preview is layered on top of the active class via
   * a higher-specificity rule and is NOT committed to history.
   */
  onPreview?: (patch: Partial<CSSPropertyBag>) => void
  /** Clear any active preview. Called on hover-leave / menu close. */
  onClearPreview?: () => void
}

// ---------------------------------------------------------------------------
// Property key helpers
// ---------------------------------------------------------------------------

function sideKey(box: Box, side: Side): keyof CSSPropertyBag {
  // Build "paddingTop", "marginRight", etc.
  return `${box}${side[0].toUpperCase()}${side.slice(1)}` as keyof CSSPropertyBag
}

// ---------------------------------------------------------------------------
// Side state — derived effective value per side & per box
// ---------------------------------------------------------------------------

interface BoxState {
  /** Per-side stored values (empty string when the side is unset). */
  effective: Record<Side, string>
  /** Whether each side has an explicit stored value. */
  storedFlags: Record<Side, boolean>
  /** All four sides are equal (and at least one is non-empty). */
  isUniform: boolean
}

function computeBoxState(
  storedStyles: Record<string, unknown>,
  box: Box,
): BoxState {
  const effective: Record<Side, string> = { top: '', right: '', bottom: '', left: '' }
  const storedFlags: Record<Side, boolean> = {
    top: false,
    right: false,
    bottom: false,
    left: false,
  }

  for (const side of SIDES) {
    const explicit = pickString(storedStyles[sideKey(box, side)])
    if (explicit) {
      effective[side] = explicit
      storedFlags[side] = true
    }
  }

  const values = SIDES.map((s) => effective[s])
  const hasAny = values.some((v) => v !== '')
  const isUniform = hasAny && values.every((v) => v === values[0])

  return { effective, storedFlags, isUniform }
}

function pickString(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return `${value}px`
  return ''
}

// ---------------------------------------------------------------------------
// SpacingBoxControl
// ---------------------------------------------------------------------------

export function SpacingBoxControl({
  storedStyles,
  currentStyles,
  onChange,
  onRemove,
  onPreview,
  onClearPreview,
}: SpacingBoxControlProps) {
  const tokens = useSpacingTokens()

  // ── Per-box state ──────────────────────────────────────────────────────
  const padding = computeBoxState(storedStyles, 'padding')
  const margin = computeBoxState(storedStyles, 'margin')

  const paddingFallback = computeBoxState(currentStyles, 'padding')
  const marginFallback = computeBoxState(currentStyles, 'margin')

  // ── Linked-mode toggles (UI state) ─────────────────────────────────────
  // Empty boxes start split: the first side edit should not fan out.
  // Uniform non-empty boxes start linked, but user unlinking is respected.
  const [paddingLinked, setPaddingLinked] = useState<boolean>(() =>
    padding.isUniform && !allEmpty(padding.effective),
  )
  const [marginLinked, setMarginLinked] = useState<boolean>(() =>
    margin.isUniform && !allEmpty(margin.effective),
  )

  // ── Last-focused side (for chip-apply target) ──────────────────────────
  const [focused, setFocused] = useState<{ box: Box; side: Side } | null>(null)
  const [linkedDraft, setLinkedDraft] = useState<{ box: Box; value: string } | null>(null)

  // ── Floating value editor (ValueEditorPopout) ──────────────────────────
  // One popout at a time: focusing a side moves it there. The anchor ref is
  // mutated to the focused input element right before the popout (re)opens.
  const [editor, setEditor] = useState<{ box: Box; side: Side } | null>(null)
  // The popout previews on every slider move / chip hover. The side fields
  // show that draft as it happens, so the numbers track the canvas instead of
  // waiting for the release that commits them.
  const [editorDraft, setEditorDraft] = useState<{ box: Box; sides: Side[]; value: string } | null>(
    null,
  )
  const editorAnchorRef = useRef<HTMLElement | null>(null)
  // Escape refocuses the anchor input, whose focus event would instantly
  // reopen the popout — suppress that one reopen.
  const suppressReopen = useRef(false)

  // ── Live canvas spacing highlight ──────────────────────────────────────
  // While a side is being interacted with (input focus, band hover, open
  // value editor), the canvas tints the corresponding spacing band(s) of the
  // selected element and shows a value chip (SpacingHighlightOverlay). The
  // highlight lists every side a write would touch — all four in linked mode.
  const setSpacingHighlight = useEditorStore((s) => s.setSpacingHighlight)

  const highlightSides = (box: Box, side: Side): Side[] =>
    (box === 'padding' ? paddingLinked : marginLinked) ? [...SIDES] : [side]

  const showHighlight = (box: Box, side: Side) => {
    setSpacingHighlight({ box, sides: highlightSides(box, side) })
  }

  const hoverSide = (box: Box, side: Side | null) => {
    if (side) {
      showHighlight(box, side)
    } else if (editor) {
      // Pointer left a band while the value editor is open — fall back to
      // the editor's target instead of clearing.
      showHighlight(editor.box, editor.side)
    } else {
      setSpacingHighlight(null)
    }
  }

  useEffect(() => {
    // Deselect / panel close unmounts the control mid-interaction — don't
    // leave a stale band on the canvas.
    return () => useEditorStore.getState().setSpacingHighlight(null)
  }, [])

  const closeEditor = () => {
    setEditor(null)
    setSpacingHighlight(null)
    suppressReopen.current = true
    setTimeout(() => {
      suppressReopen.current = false
    }, 0)
  }

  const focusSide = (box: Box, side: Side, anchor: HTMLElement | null) => {
    setFocused({ box, side })
    showHighlight(box, side)
    if (!anchor || suppressReopen.current) return
    editorAnchorRef.current = anchor
    setEditor({ box, side })
  }

  const clearLinkedDraft = (box: Box) => {
    setLinkedDraft((draft) => (draft?.box === box ? null : draft))
  }

  // ── Apply value to a box ───────────────────────────────────────────────
  const applyValue = (box: Box, side: Side | 'all', resolved: string | undefined) => {
    const isLinked = box === 'padding' ? paddingLinked : marginLinked
    const sidesToWrite: Side[] =
      side === 'all' || isLinked ? [...SIDES] : [side]

    for (const s of sidesToWrite) {
      onChange(sideKey(box, s), resolved)
    }
  }

  // ── Band scrub ─────────────────────────────────────────────────────────
  // Dragging a band segment scrubs its side — the gesture the per-side
  // resize cursors promise. Preview flows through the same channels as the
  // popout (canvas bands + live field drafts), and the release commits once
  // through applyValue so linked mode fans out identically.
  const scrubSide = (box: Box, side: Side, event: React.PointerEvent<HTMLElement>) => {
    const state = box === 'padding' ? padding : margin
    const fallback = box === 'padding' ? paddingFallback : marginFallback
    beginSideScrub(event, {
      side,
      startRaw: state.effective[side] || fallback.effective[side] || '',
      allowNegative: box === 'margin',
      onPreview: (resolved) => {
        setEditorDraft({ box, sides: highlightSides(box, side), value: resolved })
        showHighlight(box, side)
        previewValue(box, side, resolved)
      },
      onCommit: (resolved) => {
        setEditorDraft(null)
        onClearPreview?.()
        applyValue(box, side, resolved)
      },
      onCancel: () => {
        clearPreview()
        if (!editor) setSpacingHighlight(null)
      },
    })
  }

  // ── Clear a box ────────────────────────────────────────────────────────
  const clearBox = (box: Box) => {
    clearLinkedDraft(box)
    for (const s of SIDES) onRemove(sideKey(box, s))
  }

  // ── Link/unlink a box ──────────────────────────────────────────────────
  const toggleLinked = (box: Box, state: BoxState, fallback: BoxState) => {
    const isLinked = box === 'padding' ? paddingLinked : marginLinked
    const setLinked = box === 'padding' ? setPaddingLinked : setMarginLinked

    if (isLinked) {
      clearLinkedDraft(box)
      setLinked(false)
      return
    }

    clearLinkedDraft(box)
    const preferredSide = focused?.box === box ? focused.side : null
    const sourceSide = pickSyncSourceSide(state, preferredSide)
    const value = state.effective[sourceSide] || fallback.effective[sourceSide] || undefined
    for (const side of SIDES) onChange(sideKey(box, side), value)
    setLinked(true)
  }

  // ── Linked draft mirroring ─────────────────────────────────────────────
  const updateLinkedDraft = (box: Box, draft: string) => {
    const isLinked = box === 'padding' ? paddingLinked : marginLinked
    if (!isLinked) return
    setLinkedDraft({ box, value: draft })
  }

  // ── Preview value (transient, not history-tracked) ─────────────────────
  const previewValue = (box: Box, side: Side, resolved: string | undefined) => {
    if (!onPreview) return
    const isLinked = box === 'padding' ? paddingLinked : marginLinked
    const sidesToWrite: Side[] = isLinked ? [...SIDES] : [side]
    const patch: Partial<CSSPropertyBag> = {}
    for (const s of sidesToWrite) {
      // Cast to never because CSSPropertyBag values are typed per-key;
      // we trust the resolved value matches the property's expected type.
      ;(patch as Record<string, unknown>)[sideKey(box, s)] = resolved
    }
    onPreview(patch)
  }

  const clearPreview = () => {
    setEditorDraft(null)
    onClearPreview?.()
  }

  return (
    <div className={styles.root}>
      <SpacingBox
        box="margin"
        label="Margin"
        state={margin}
        fallback={marginFallback}
        linked={marginLinked}
        onToggleLinked={() => toggleLinked('margin', margin, marginFallback)}
        focused={focused?.box === 'margin' ? focused.side : null}
        setFocused={(side, anchor) => focusSide('margin', side, anchor)}
        onSideHover={(side) => hoverSide('margin', side)}
        onSideScrub={(side, event) => scrubSide('margin', side, event)}
        linkedDraft={linkedDraft?.box === 'margin' ? linkedDraft.value : null}
        editorDraft={editorDraft?.box === 'margin' ? editorDraft : null}
        tokens={tokens}
        onSideValue={(side, resolved) => applyValue('margin', side, resolved)}
        onSidePreview={(side, resolved) => previewValue('margin', side, resolved)}
        onSideDraft={(draft) => updateLinkedDraft('margin', draft)}
        onClearDraft={() => clearLinkedDraft('margin')}
        onClearPreview={clearPreview}
        onClear={() => clearBox('margin')}
        nested={
          <SpacingBox
            box="padding"
            label="Padding"
            state={padding}
            fallback={paddingFallback}
            linked={paddingLinked}
            onToggleLinked={() => toggleLinked('padding', padding, paddingFallback)}
            focused={focused?.box === 'padding' ? focused.side : null}
            setFocused={(side, anchor) => focusSide('padding', side, anchor)}
            onSideHover={(side) => hoverSide('padding', side)}
            onSideScrub={(side, event) => scrubSide('padding', side, event)}
            linkedDraft={linkedDraft?.box === 'padding' ? linkedDraft.value : null}
            editorDraft={editorDraft?.box === 'padding' ? editorDraft : null}
            tokens={tokens}
            onSideValue={(side, resolved) =>
              applyValue('padding', side, resolved)
            }
            onSidePreview={(side, resolved) =>
              previewValue('padding', side, resolved)
            }
            onSideDraft={(draft) => updateLinkedDraft('padding', draft)}
            onClearDraft={() => clearLinkedDraft('padding')}
            onClearPreview={clearPreview}
            onClear={() => clearBox('padding')}
          />
        }
      />

      {editor ? (
        <ValueEditorPopout
          // Keyed by target so switching sides remounts: local drafts reset
          // and the FloatingPanel re-places beside the new anchor.
          key={`${editor.box}-${editor.side}`}
          open
          onClose={closeEditor}
          anchorRef={editorAnchorRef}
          title={`${editor.box === 'margin' ? 'Margin' : 'Padding'} ${editor.side}`}
          value={(editor.box === 'margin' ? margin : padding).effective[editor.side]}
          allowAuto={editor.box === 'margin'}
          // Margins collapse and pull; padding cannot go negative — that is a
          // CSS rule, not a policy choice, so the slider floor stays at 0.
          allowNegative={editor.box === 'margin'}
          tokens={tokens}
          onCommit={(resolved) => {
            setEditorDraft(null)
            applyValue(editor.box, editor.side, resolved)
          }}
          onPreview={(resolved) => {
            setEditorDraft({
              box: editor.box,
              sides: highlightSides(editor.box, editor.side),
              value: resolved ?? '',
            })
            previewValue(editor.box, editor.side, resolved)
          }}
          onClearPreview={clearPreview}
        />
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// SpacingBox — one of margin / padding
// ---------------------------------------------------------------------------

interface SpacingBoxProps {
  box: Box
  label: string
  state: BoxState
  fallback: BoxState
  linked: boolean
  onToggleLinked: () => void
  focused: Side | null
  /** Fired on side-input focus with the input element — the popout's anchor. */
  setFocused: (side: Side, anchor: HTMLElement | null) => void
  /** Pointer entered (`side`) / left (`null`) a side's band segment. */
  onSideHover: (side: Side | null) => void
  /** Pointer pressed a band segment — may become a value scrub. */
  onSideScrub: (side: Side, event: React.PointerEvent<HTMLElement>) => void
  linkedDraft: string | null
  /** Live draft from the open value editor — wins over the stored value. */
  editorDraft: { sides: Side[]; value: string } | null
  tokens: ReadonlyArray<Token>
  onSideValue: (side: Side, resolved: string | undefined) => void
  onSidePreview: (side: Side, resolved: string | undefined) => void
  onSideDraft: (draft: string) => void
  onClearDraft: () => void
  onClearPreview: () => void
  onClear: () => void
  nested?: React.ReactNode
}

function SpacingBox({
  box,
  label,
  state,
  fallback,
  linked,
  onToggleLinked,
  focused,
  setFocused,
  onSideHover,
  onSideScrub,
  linkedDraft,
  editorDraft,
  tokens,
  onSideValue,
  onSidePreview,
  onSideDraft,
  onClearDraft,
  onClearPreview,
  onClear,
  nested,
}: SpacingBoxProps) {
  // Set count (used to enable/disable Clear button).
  const setCount = SIDES.filter((s) => state.storedFlags[s]).length

  const sideValue = (side: Side): string => {
    if (editorDraft?.sides.includes(side)) return editorDraft.value
    if (linked && linkedDraft !== null) return linkedDraft
    return state.effective[side]
  }

  // Widest rendered left/right value, in characters — includes live scrub /
  // popout drafts via sideValue, so the band follows the value as it grows.
  const sideChars = Math.max(
    1,
    ...(['left', 'right'] as const).map((side) =>
      sideDisplayChars(sideValue(side) || fallback.effective[side] || '0', tokens),
    ),
  )

  return (
    <div
      className={cn(styles.box, styles[`box--${box}`])}
      data-linked={linked ? 'true' : undefined}
      // Dynamic custom property (the module reads it back via var()) — the
      // sanctioned inline-style exception.
      style={{ '--side-chars': sideChars } as React.CSSProperties}
    >
      <SpacingBoxHeader
        label={label}
        linked={linked}
        onToggleLinked={onToggleLinked}
        clearDisabled={setCount === 0}
        onClear={onClear}
      />

      {SIDES.map((side) => (
        <SideInput
          key={side}
          box={box}
          side={side}
          value={sideValue(side)}
          placeholder={fallback.effective[side]}
          isSet={state.storedFlags[side]}
          isLinkedTarget={linked && state.isUniform}
          isFocusedTarget={focused === side}
          tokens={tokens}
          onCommit={(resolved) => onSideValue(side, resolved)}
          onFocus={(anchor) => setFocused(side, anchor)}
          onHover={(hovering) => onSideHover(hovering ? side : null)}
          onScrub={(event) => onSideScrub(side, event)}
          onPreview={(resolved) => onSidePreview(side, resolved)}
          onDraftChange={onSideDraft}
          onDraftClear={onClearDraft}
          onClearPreview={onClearPreview}
        />
      ))}

      {/* The band's only in-flow child, so the bands measure from it: the
          margin band holds the padding band, the padding band holds the
          core. The core is what gives the widget its height. */}
      {nested ? (
        <div className={styles.boxInner}>{nested}</div>
      ) : (
        <div className={styles.boxCore} />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// SideInput — token-aware input on a box edge
// ---------------------------------------------------------------------------

interface SideInputProps {
  box: Box
  side: Side
  value: string
  placeholder: string
  isSet: boolean
  isLinkedTarget: boolean
  isFocusedTarget: boolean
  tokens: ReadonlyArray<Token>
  onCommit: (resolved: string | undefined) => void
  onFocus: (anchor: HTMLElement | null) => void
  /** Pointer entered/left this side's band segment — drives the canvas highlight. */
  onHover: (hovering: boolean) => void
  /** Pointer pressed the segment — beginSideScrub decides click vs scrub. */
  onScrub: (event: React.PointerEvent<HTMLElement>) => void
  onPreview: (resolved: string | undefined) => void
  onDraftChange: (draft: string) => void
  onDraftClear: () => void
  onClearPreview: () => void
}

function SideInput({
  box,
  side,
  value,
  placeholder,
  isSet,
  isLinkedTarget,
  isFocusedTarget,
  tokens,
  onCommit,
  onFocus,
  onHover,
  onScrub,
  onPreview,
  onDraftChange,
  onDraftClear,
  onClearPreview,
}: SideInputProps) {
  const inputId = useId()

  // The label segment provides the broad click/focus hit area while the input
  // itself remains the semantic text control. The input is a SIBLING of the
  // label, not a child: the segment's trapezoid `clip-path` would clip a
  // grown value ("1000px") the moment it left the band. Both are absolutely
  // positioned against the same `.box`, so the geometry is unchanged. The
  // whole token-autocomplete behaviour — draft state, suggestion filtering,
  // commit, hover/typed preview, the Suggested/All dropdown — lives in
  // TokenAwareInput.
  return (
    <>
      <label
        htmlFor={inputId}
        className={cn(
          styles.segment,
          styles[`segment--${side}`],
          isLinkedTarget && styles.segmentLinked,
          isFocusedTarget && styles.segmentFocused,
        )}
        data-state={isSet ? 'set' : 'unset'}
        onPointerEnter={() => onHover(true)}
        onPointerLeave={() => onHover(false)}
        onPointerDown={onScrub}
      />
      <TokenAwareInput
        id={inputId}
        value={value}
        placeholder={placeholder || '0'}
        tokens={tokens}
        fieldSize="xs"
        overlay
        tooltipOnOverflow
        hideTokenMenu
        aria-label={`${box} ${side}`}
        menuAriaLabel={`${box} ${side} spacing tokens`}
        inputClassName={cn(
          styles.sideInput,
          styles[`sideInput--${side}`],
          isLinkedTarget && styles.sideInputLinked,
        )}
        onCommit={onCommit}
        // The input element doubles as the value-editor popout's anchor; the
        // id is already on it for the label, so read it back by id.
        onFocus={() => onFocus(document.getElementById(inputId))}
        onPreview={onPreview}
        onDraftChange={onDraftChange}
        onDraftClear={onDraftClear}
        onClearPreview={onClearPreview}
      />
    </>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function allEmpty(map: Record<Side, string>): boolean {
  return SIDES.every((s) => !map[s])
}

function pickSyncSourceSide(state: BoxState, preferredSide: Side | null): Side {
  if (preferredSide) return preferredSide
  return SIDES.find((side) => state.effective[side] !== '') ?? 'top'
}
