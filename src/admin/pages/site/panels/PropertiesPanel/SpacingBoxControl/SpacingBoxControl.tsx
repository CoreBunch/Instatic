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
 * Storage model:
 *   - The control owns paddingTop/Right/Bottom/Left and marginTop/Right/
 *     Bottom/Left as the source of truth.
 *   - There is no shorthand `padding` / `margin` key in storage — that
 *     ambiguity is removed at the schema level. The publisher collapses
 *     the 4 sides into the CSS shorthand (`padding: 20px 0;`) at emission
 *     time (see `bagToCSS` in `core/publisher/classCss.ts`).
 */

import { useId, useState } from 'react'
import type { CSSPropertyBag } from '@core/page-tree'
import { Button } from '@ui/components/Button'
import { LinkIcon } from 'pixel-art-icons/icons/link'
import { RemoveXGlyph } from '@ui/icons/inspectorGlyphs'
import { cn } from '@ui/cn'
import { TokenAwareInput } from '@site/property-controls/TokenAwareInput'
import { useSpacingTokens, type Token } from '@site/property-controls/tokenUtils'
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
        setFocused={(side) => setFocused({ box: 'margin', side })}
        linkedDraft={linkedDraft?.box === 'margin' ? linkedDraft.value : null}
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
            setFocused={(side) => setFocused({ box: 'padding', side })}
            linkedDraft={linkedDraft?.box === 'padding' ? linkedDraft.value : null}
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
  setFocused: (side: Side) => void
  linkedDraft: string | null
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
  linkedDraft,
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

  return (
    <div className={cn(styles.box, styles[`box--${box}`])} data-linked={linked ? 'true' : undefined}>
      <div className={styles.boxHeader}>
        <span className={styles.boxLabel}>{label}</span>
        <div className={styles.boxHeaderActions}>
          <Button
            type="button"
            variant="ghost"
            size="micro"
            iconOnly
            onClick={onToggleLinked}
            aria-pressed={linked}
            aria-label={linked ? `Unlink ${label} sides` : `Link all ${label} sides`}
            tooltip={linked ? 'Linked — edits all four sides' : 'Split — edit each side separately'}
            className={styles.headerBtn}
          >
            <LinkIcon size={11} aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="micro"
            iconOnly
            onClick={onClear}
            disabled={setCount === 0}
            aria-label={`Clear ${label}`}
            tooltip={`Clear ${label}`}
            className={styles.headerBtn}
          >
            <RemoveXGlyph />
          </Button>
        </div>
      </div>

      {SIDES.map((side) => (
        <SideInput
          key={side}
          box={box}
          side={side}
          value={linked && linkedDraft !== null ? linkedDraft : state.effective[side]}
          placeholder={fallback.effective[side]}
          isSet={state.storedFlags[side]}
          isLinkedTarget={linked && state.isUniform}
          isFocusedTarget={focused === side}
          tokens={tokens}
          onCommit={(resolved) => onSideValue(side, resolved)}
          onFocus={() => setFocused(side)}
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
  onFocus: () => void
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
  onPreview,
  onDraftChange,
  onDraftClear,
  onClearPreview,
}: SideInputProps) {
  const inputId = useId()

  // The label segment provides the broad click/focus hit area while the input
  // itself remains the semantic text control. The whole token-autocomplete
  // behaviour — draft state, suggestion filtering, commit, hover/typed
  // preview, the Suggested/All dropdown — lives in TokenAwareInput.
  return (
    <label
      htmlFor={inputId}
      className={cn(
        styles.segment,
        styles[`segment--${side}`],
        isLinkedTarget && styles.segmentLinked,
        isFocusedTarget && styles.segmentFocused,
      )}
      data-state={isSet ? 'set' : 'unset'}
    >
      <TokenAwareInput
        id={inputId}
        value={value}
        placeholder={placeholder || '0'}
        tokens={tokens}
        fieldSize="xs"
        overlay
        tooltipOnOverflow
        aria-label={`${box} ${side}`}
        menuAriaLabel={`${box} ${side} spacing tokens`}
        inputClassName={styles.sideInput}
        onCommit={onCommit}
        onFocus={onFocus}
        onPreview={onPreview}
        onDraftChange={onDraftChange}
        onDraftClear={onDraftClear}
        onClearPreview={onClearPreview}
      />
    </label>
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
