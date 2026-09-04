/**
 * ClassPropertyRow — unified CSS property editing row.
 *
 * Renders a single CSSPropertyBag entry as a typed control row.
 * Uses the SAME property-control components as the Module section
 * (TextControl / ColorControl / SelectControl),
 * producing byte-identical DOM + className tokens (PP-18 acceptance criterion).
 *
 * A remove button is overlaid on each row via position:absolute so the
 * control itself is visually unchanged from a module property row.
 *
 * Phase 3 / Task #464 / Spec #671.
 */

import { useState } from 'react'
import type { CSSPropertyBag } from '@core/page-tree'
import { TextControl } from '@site/property-controls/TextControl'

/**
 * Properties the design canvas deliberately neutralises (iframeBodyReset.ts:
 * `cursor` / `user-select` so the frame reads as click-to-select,
 * `transition` so edits land the same frame). They still publish and still
 * apply in the live frame — the row says so instead of looking dead.
 */
const CANVAS_HIDDEN_PROPERTIES = new Set<keyof CSSPropertyBag>([
  'cursor',
  'userSelect',
  'transition',
])
import { ColorControl } from '@site/property-controls/ColorControl'
import { SelectControl } from '@site/property-controls/SelectControl'
import { BackgroundImageControl } from '@site/property-controls/BackgroundImageControl'
import { BackgroundFillControl } from '@site/property-controls/BackgroundFillControl'
import { FontFamilyControl } from '@site/property-controls/FontFamilyControl'
import { PositionControl } from '@site/property-controls/PositionControl'
import { useEditorStore } from '@site/store/store'
import { ControlRow } from '@ui/components/ControlRow'
import { Input } from '@ui/components/Input'
import { TokenAwareInput } from '@site/property-controls/TokenAwareInput'
import { UnitField } from '@site/property-controls/UnitField'
import {
  useSpacingTokens,
  useTypographyTokens,
  type Token,
} from '@site/property-controls/tokenUtils'
import { Button } from '@ui/components/Button'
import { isGradient } from '@ui/components/ColorPicker'
import { RemoveDashGlyph } from '@ui/icons/inspectorGlyphs'
import {
  getCSSPropertyControlType,
  getCSSPropertyTokenSource,
  getEnumOptions,
  cssPropertyLabel,
  LENGTH_PROPERTIES,
  NUMBER_TYPED_PROPS,
} from './cssControlTypes'
import { getFontWeightOptions } from './fontWeightOptions'
import { stepCssLength } from './styleValueUtils'
import styles from './ClassPropertyRow.module.css'

// ---------------------------------------------------------------------------
// ClassPropertyRow
// ---------------------------------------------------------------------------

interface ClassPropertyRowProps {
  property: keyof CSSPropertyBag
  value: string | number | undefined
  placeholder?: string | number
  /** Override the auto-derived label (e.g. "Fill" instead of "Background color"). */
  labelOverride?: string
  fontFamilyValue?: unknown
  /**
   * Current `background-image`. Sibling value, like `fontFamilyValue`: the
   * `backgroundColor` row renders the unified fill control, which needs to
   * know whether a gradient is currently painting over the colour.
   */
  backgroundImageValue?: unknown
  isSet?: boolean
  /**
   * Does this row have a handle that takes the WHOLE row away?
   *
   * Only rows added from a section's "+" do (inspector-panel.md §5, rule 1).
   * A standing row — Fill, Radius, Overflow — cannot be removed: it belongs to
   * the section whether or not it holds a value, and its × clears the value
   * inside the field. Giving it a dash too would put two marks on one row for
   * two different actions, and the dash would promise something ("remove this
   * row") the section cannot deliver.
   */
  removable?: boolean
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  /** Applies several properties in one store commit (one undo entry). */
  onChangeMany?: (patch: Partial<CSSPropertyBag>) => void
  onRemove: (property: keyof CSSPropertyBag) => void
  /**
   * Optional hover-preview hooks. When provided, the row forwards them to
   * whichever control supports a suggestion dropdown (token autocomplete,
   * colour-token menu, enum select) so hovering a suggestion transiently
   * applies it to the canvas. `onClearPreview` fires on leave / close.
   * Gating against the `hoverPreview` preference happens inside the leaf
   * controls, so the row can pass these through unconditionally.
   */
  onPreview?: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onClearPreview?: () => void
}

export function ClassPropertyRow({
  property,
  value,
  placeholder,
  labelOverride,
  fontFamilyValue,
  backgroundImageValue,
  isSet = true,
  removable = false,
  onChange,
  onChangeMany,
  onRemove,
  onPreview,
  onClearPreview,
}: ClassPropertyRowProps) {
  const type = getCSSPropertyControlType(property)
  const tokenSource = getCSSPropertyTokenSource(property)
  const label = labelOverride ?? cssPropertyLabel(String(property))
  const placeholderText = placeholder !== undefined ? String(placeholder) : undefined
  const fonts = useEditorStore((state) => state.site?.settings.fonts ?? null)
  const isNumberTyped = NUMBER_TYPED_PROPS.has(property)
  // Numeric CSS values are persisted as numbers, but their text fields need
  // to retain lexical editing states such as `0.`, `-`, and `1e`. `null`
  // means the field is not being edited and should reflect the stored value.
  const [numberDraft, setNumberDraft] = useState<string | null>(null)

  // Always read both token catalogs — hooks must run unconditionally on
  // every render. The selected catalog is forwarded to TokenAwareInput
  // when the property has a `tokenSource`, otherwise it's unused (no cost).
  const spacingTokens = useSpacingTokens()
  const typographyTokens = useTypographyTokens()
  const tokens: ReadonlyArray<Token> =
    tokenSource === 'typography'
      ? typographyTokens
      : tokenSource === 'spacing'
        ? spacingTokens
        : []

  const commitNumberValue = (rawValue: string) => {
    const trimmed = rawValue.trim()
    if (trimmed === '') {
      if (value !== undefined) onChange(property, undefined)
      return
    }

    const parsed = Number(trimmed)
    if (Number.isFinite(parsed) && !Object.is(value, parsed)) {
      onChange(property, parsed)
    }
  }

  // Translate a control's (propKey, val) onChange signature into a typed
  // CSSPropertyBag value. Number-typed properties keep the raw focused draft
  // in the input while finite values continue to update the canvas live.
  const handleControlChange = (_key: string, val: unknown) => {
    const nextValue = String(val ?? '')
    if (isNumberTyped) {
      setNumberDraft(nextValue)
      commitNumberValue(nextValue)
      return
    }
    onChange(property, nextValue)
  }

  const handleNumberFocus = () => {
    if (isNumberTyped) setNumberDraft(String(value ?? ''))
  }

  const handleNumberBlur = (nextValue: string) => {
    if (!isNumberTyped) return
    commitNumberValue(nextValue)
    // Returning to the stored value also canonicalizes incomplete drafts:
    // `0.` becomes `0`, while an uncommittable `-`/`.` is discarded.
    setNumberDraft(null)
  }

  // Token-aware properties commit on blur via TokenAwareInput's `onCommit`.
  // It already returns undefined for empty input (clears the value), so
  // the only translation we do here is the number-typed coercion.
  const handleTokenCommit = (resolved: string | undefined) => {
    if (isNumberTyped) {
      if (resolved == null || resolved === '') {
        onChange(property, undefined)
        return
      }
      const parsed = Number(resolved)
      onChange(property, Number.isFinite(parsed) ? parsed : resolved)
      return
    }
    onChange(property, resolved)
  }

  // Preview counterparts — same value coercion as the commit handlers, but
  // routed to `onPreview` so the value lands on the canvas transiently
  // (no history entry). No-op when the parent didn't wire a preview channel.
  const handleControlPreview = (_key: string, val: unknown) => {
    if (!onPreview) return
    const nextValue = String(val ?? '')
    if (isNumberTyped) {
      const parsed = Number(nextValue)
      onPreview(property, Number.isFinite(parsed) && nextValue.trim() !== '' ? parsed : undefined)
      return
    }
    onPreview(property, nextValue)
  }

  const handleTokenPreview = (resolved: string | undefined) => {
    if (!onPreview) return
    if (isNumberTyped) {
      if (resolved == null || resolved === '') {
        onPreview(property, undefined)
        return
      }
      const parsed = Number(resolved)
      onPreview(property, Number.isFinite(parsed) ? parsed : resolved)
      return
    }
    onPreview(property, resolved)
  }

  // ── Dispatch to the correct control ─────────────────────────────────────
  // Each control renders with its own .controlWrapper so the row is
  // visually identical to a module property row (PP-18). When the property
  // has a framework variable scale (`tokenSource`), the token-aware input
  // takes precedence over the generic text/select dispatch below.
  let control: React.ReactNode

  if (property === 'fontFamily') {
    control = (
      <FontFamilyControl
        propKey={String(property)}
        value={String(value ?? '')}
        placeholder={placeholderText}
        onChange={handleControlChange}
        label={label}
        onPreview={onPreview ? (v) => handleControlPreview(String(property), v) : undefined}
        onClearPreview={onClearPreview}
      />
    )
  } else if (tokenSource) {
    control = (
      <ControlRow propKey={String(property)} label={label}>
        <TokenAwareInput
          aria-label={label}
          value={value !== undefined ? String(value) : undefined}
          placeholder={placeholderText}
          tokens={tokens}
          onCommit={handleTokenCommit}
          // Every token-source property is a length, so every one of them
          // is worth stepping and scrubbing.
          stepValue={(current, delta) =>
            stepCssLength(current || '0px', delta, { min: Number.NEGATIVE_INFINITY })
          }
          onPreview={onPreview ? handleTokenPreview : undefined}
          onClearPreview={onClearPreview}
        />
      </ControlRow>
    )
  } else if (LENGTH_PROPERTIES.has(property)) {
    // Plain lengths render as value ⊕ unit — a number field plus a unit /
    // keyword select — never one free-text input (author's reference panel).
    const spec = LENGTH_PROPERTIES.get(property)!
    control = (
      <ControlRow propKey={String(property)} label={label}>
        <UnitField
          id={`ctrl-${String(property)}`}
          value={value !== undefined ? String(value) : undefined}
          placeholder={placeholderText}
          units={spec.units}
          keywords={spec.keywords}
          aria-label={label}
          onCommit={(raw) => {
            if (raw === undefined) onRemove(property)
            else onChange(property, raw)
          }}
          onPreview={onPreview ? (raw) => handleControlPreview(String(property), raw) : undefined}
          onClearPreview={onClearPreview}
        />
      </ControlRow>
    )
  } else if (property === 'aspectRatio') {
    // A ratio, not prose: digits, a decimal point, and one `/` ("1.5", "16/9").
    control = (
      <ControlRow propKey={String(property)} label={label}>
        <AspectRatioField
          value={value !== undefined ? String(value) : ''}
          placeholder={placeholderText}
          ariaLabel={label}
          onChange={(next) => onChange(property, next)}
          onClear={() => onRemove(property)}
        />
      </ControlRow>
    )
  } else if (property === 'backgroundImage') {
    // background-image gets its own multi-mode control (None / Image picker /
    // Gradient text). See BackgroundImageControl for the value-string format
    // (`url('...')` / `linear-gradient(...)` / empty) — chosen so imported
    // CSS from the Super Import pipeline lands on the right tab without any
    // post-processing. We intentionally drop the schema-level placeholder
    // (always `none` here, which is unhelpful inside the gradient input).
    control = (
      <BackgroundImageControl
        propKey={String(property)}
        value={String(value ?? '')}
        onChange={handleControlChange}
        label={label}
      />
    )
  } else if (property === 'objectPosition' || property === 'backgroundPosition') {
    // A `<position>` is two anchors, not a phrase: the row opens a 3×3 grid
    // popout (plus X / Y offsets) instead of asking for "center center".
    control = (
      <PositionControl
        propKey={String(property)}
        value={String(value ?? '')}
        placeholder={placeholderText}
        onChange={handleControlChange}
        label={label}
        onPreview={onPreview ? handleControlPreview : undefined}
        onClearPreview={onClearPreview}
      />
    )
  } else if (property === 'backgroundColor' && onChangeMany) {
    // The background swatch is a FILL, not just a colour: it also offers the
    // picker's gradient tabs, and routes a gradient to `background-image`
    // because `background-color` cannot hold one. See BackgroundFillControl.
    control = (
      <BackgroundFillControl
        propKey={String(property)}
        colorValue={String(value ?? '')}
        imageValue={String(backgroundImageValue ?? '')}
        placeholder={placeholderText}
        onChangeMany={onChangeMany}
        label={label}
        onPreview={onPreview ? (v) => handleControlPreview(String(property), v) : undefined}
        onClearPreview={onClearPreview}
      />
    )
  } else switch (type) {
    case 'color':
      control = (
        // NO value-derived key here: remounting on every colour commit would
        // close the picker panel mid-drag. ColorValueInput adopts external
        // value changes on its own (render-time previous-value comparison).
        <ColorControl
          propKey={String(property)}
          value={String(value ?? '')}
          placeholder={placeholderText}
          onChange={handleControlChange}
          label={label}
          onPreview={onPreview ? (v) => handleControlPreview(String(property), v) : undefined}
          onClearPreview={onClearPreview}
        />
      )
      break

    case 'select': {
      const enumOptions = getEnumOptions(property) ?? []
      const opts = property === 'fontWeight'
        ? getFontWeightOptions(fontFamilyValue, fonts, enumOptions)
        : enumOptions
      control = (
        <SelectControl
          propKey={String(property)}
          value={String(value ?? '')}
          placeholder={placeholderText}
          onChange={handleControlChange}
          label={label}
          options={[
            { label: '—', value: '' },
            ...opts.map((o) => ({ label: o, value: o })),
          ]}
          onPreview={onPreview ? (v) => handleControlPreview(String(property), v) : undefined}
          onClearPreview={onClearPreview}
        />
      )
      break
    }

    case 'text':
    default:
      control = (
        <TextControl
          propKey={String(property)}
          value={isNumberTyped && numberDraft !== null ? numberDraft : String(value ?? '')}
          placeholder={placeholderText}
          onChange={handleControlChange}
          label={label}
          onInputFocus={isNumberTyped ? handleNumberFocus : undefined}
          onInputBlur={isNumberTyped ? handleNumberBlur : undefined}
        />
      )
      break
  }

  // The background fill row stands for TWO properties, so a gradient living
  // on `background-image` makes the row "set" even with no colour — and
  // clearing it has to retire both keys, in one undo step.
  const fillGradient =
    property === 'backgroundColor' && isGradient(String(backgroundImageValue ?? ''))
  const rowIsSet = isSet || fillGradient

  function handleRemove() {
    if (fillGradient && onChangeMany) {
      onChangeMany({ backgroundColor: undefined, backgroundImage: undefined })
      return
    }
    onRemove(property)
  }

  // An added row only earns its handle once it holds a value — an empty one
  // is removed by clearing it, not by a second control.
  const showHandle = removable && rowIsSet && property !== 'backgroundImage'

  return (
    <div
      className={styles.propertyRowWrap}
      data-state={rowIsSet ? 'set' : 'unset'}
      data-removable={showHandle ? 'true' : undefined}
      data-testid={`css-property-row-${String(property)}`}
    >
      {/* Control renders with its own .controlWrapper — identical to module rows (PP-18) */}
      {control}
      {CANVAS_HIDDEN_PROPERTIES.has(property) && (
        <span className={styles.rowHint}>Applies on the published page — the canvas hides it.</span>
      )}

      {/* Row handle (`.rowx`) — always visible, in the row's own trailing
          column. It wears a DASH, not a cross: the cross clears a value and
          sits inside the field, this takes the whole row away
          (docs/features/inspector-panel.md §5). */}
      {showHandle && (
        <Button
          variant="ghost"
          size="micro"
          iconOnly
          onClick={handleRemove}
          aria-label={`Remove ${label} property`}
          tooltip={`Remove ${label}`}
          className={styles.removeBtn}
        >
          <RemoveDashGlyph />
        </Button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// AspectRatioField — digits, one decimal point per part, one `/`
// ---------------------------------------------------------------------------

/** `1.5`, `16/9`, and every partial state on the way there. */
const RATIO_DRAFT_RE = /^\d*\.?\d*(\/\d*\.?\d*)?$/

interface AspectRatioFieldProps {
  value: string
  placeholder?: string
  ariaLabel: string
  onChange: (next: string) => void
  onClear: () => void
}

function AspectRatioField({ value, placeholder, ariaLabel, onChange, onClear }: AspectRatioFieldProps) {
  const [draft, setDraft] = useState<string | null>(null)

  const commit = (raw: string) => {
    const trimmed = raw.trim().replace(/\/$/, '')
    if (trimmed === '') {
      if (value !== '') onClear()
      return
    }
    if (RATIO_DRAFT_RE.test(trimmed) && trimmed !== value) onChange(trimmed)
  }

  return (
    <Input
      fieldSize="sm"
      inputMode="decimal"
      aria-label={ariaLabel}
      value={draft ?? value}
      placeholder={placeholder}
      onFocus={() => setDraft(value)}
      onChange={(event) => {
        const next = event.target.value
        if (!RATIO_DRAFT_RE.test(next.trim())) return
        setDraft(next)
        commit(next)
      }}
      onBlur={(event) => {
        commit(event.target.value)
        setDraft(null)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') (event.target as HTMLInputElement).blur()
      }}
    />
  )
}
