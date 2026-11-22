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

import { MinusIcon } from 'pixel-art-icons/icons/minus'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { NumericStyleInput } from '@site/property-controls/NumericStyleInput'
import { Input } from '@ui/components/Input'
import { useState } from 'react'
import type { CSSPropertyBag } from '@core/page-tree'
import { TextControl } from '@site/property-controls/TextControl'
import { ColorControl } from '@site/property-controls/ColorControl'
import { SelectControl } from '@site/property-controls/SelectControl'
import { BackgroundImageControl } from '@site/property-controls/BackgroundImageControl'
import { FontFamilyControl } from '@site/property-controls/FontFamilyControl'
import { useEditorStore } from '@site/store/store'
import { ControlRow } from '@ui/components/ControlRow'
import { TokenAwareInput } from '@site/property-controls/TokenAwareInput'
import {
  useSpacingTokens,
  useTypographyTokens,
  type Token,
} from '@site/property-controls/tokenUtils'
import { Button } from '@ui/components/Button'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import { cn } from '@ui/cn'
import {
  getCSSPropertyControlType,
  getCSSPropertyTokenSource,
  getEnumOptions,
  cssPropertyLabel,
  NUMBER_TYPED_PROPS,
} from './cssControlTypes'
import { getFontWeightOptions } from './fontWeightOptions'
import styles from './ClassPropertyRow.module.css'

// ---------------------------------------------------------------------------
// ClassPropertyRow
// ---------------------------------------------------------------------------

interface ClassPropertyRowProps {
  property: keyof CSSPropertyBag
  value: string | number | undefined
  labelText?: string
  placeholder?: string | number
  fontFamilyValue?: unknown
  isSet?: boolean
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
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
  labelText,
  fontFamilyValue,
  isSet = true,
  onChange,
  onRemove,
  onPreview,
  onClearPreview,
}: ClassPropertyRowProps) {
  const type = getCSSPropertyControlType(property)
  const tokenSource = getCSSPropertyTokenSource(property)
  const propertyName = cssPropertyLabel(String(property))
  const label = labelText ?? propertyName
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
          onPreview={onPreview ? handleTokenPreview : undefined}
          onClearPreview={onClearPreview}
        />
      </ControlRow>
    )
  } else if (property === 'zIndex' || property === 'opacity') {
    const effective = Number(value ?? placeholder ?? (property === 'opacity' ? 1 : 0))
    control = (
      <ControlRow propKey={property} label={label}>
        <div className={styles.numberPair}>
          <NumericStyleInput showStepper={property !== 'zIndex'} increment={property === 'opacity' ? 0.01 : 1}
            min={property === 'opacity' ? 0 : undefined} max={property === 'opacity' ? 1 : undefined}
            onScrubPreview={handleTokenPreview} onClearPreview={onClearPreview}
            onAdjust={(v) => { setNumberDraft(null); onChange(property, Number(v)) }}
            id={`ctrl-${property}`}
            aria-label={label}
            fieldSize="sm"
            value={numberDraft ?? String(value ?? '')}
            placeholder={placeholderText}
            onFocus={handleNumberFocus}
            onBlur={(event) => handleNumberBlur(event.target.value)}
            onChange={(event) => handleControlChange(property, event.target.value)}
          />
          {property === 'opacity' ? (
            <Input type="range" min={0} max={1} step={0.01} aria-label="Opacity slider"
              className={styles.opacitySlider} value={Number.isFinite(effective) ? effective : 1}
              onChange={(event) => onChange(property, Number(event.target.value))} />
          ) : (
            <div className={styles.stepButtons}>
              <Button variant="secondary" size="sm" fullWidth aria-label="Decrease Z index"
                onClick={() => onChange(property, (effective || 0) - 1)}><MinusIcon size={12} /></Button>
              <Button variant="secondary" size="sm" fullWidth aria-label="Increase Z index"
                onClick={() => onChange(property, (effective || 0) + 1)}><PlusIcon size={12} /></Button>
            </div>
          )}
        </div>
      </ControlRow>
    )
  } else if (['letterSpacing', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight', 'rowGap', 'columnGap'].includes(property)) {
    control = <ControlRow propKey={property} label={label}>
      <NumericStyleInput defaultUnit="px" id={`ctrl-${property}`} aria-label={label} fieldSize="sm"
        value={String(value ?? '')} placeholder={placeholderText} min={property === 'letterSpacing' ? undefined : 0}
        onScrubPreview={handleTokenPreview} onClearPreview={onClearPreview}
        onAdjust={(v) => onChange(property, v)} onChange={(event) => handleControlChange(property, event.target.value)} />
    </ControlRow>
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
  } else switch (type) {
    case 'color':
      control = (
        <ColorControl richPicker
          key={String(property)}
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

  return (
    <div
      className={cn(styles.propertyRowWrap, !isSet && styles.propertyRowUnset)}
      data-state={isSet ? 'set' : 'unset'}
      data-testid={`css-property-row-${String(property)}`}
    >
      {/* Control renders with its own .controlWrapper — identical to module rows (PP-18) */}
      {control}

      {/* Remove button: overlaid on the label column; revealed on hover/focus-within */}
      {isSet && (
        <Button
          variant="ghost"
          size="micro"
          iconOnly
          onClick={() => onRemove(property)}
          aria-label={`Remove ${propertyName} property`}
          tooltip={`Remove ${label}`}
          className={styles.removeBtn}
        >
          <CloseIcon size={16} color="currentColor" aria-hidden="true" />
        </Button>
      )}
    </div>
  )
}
