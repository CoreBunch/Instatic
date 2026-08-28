import { useEffect } from 'react'
import { useEditorPreference } from '@site/preferences/editorPreferences'
import { TokenizedColorField } from './TokenizedColorField'

interface ColorValueInputProps {
  /** Optional id for the text input (used for `htmlFor` linkage by callers). */
  id?: string
  /** Committed colour value (`#rrggbb`, `rgb(...)`, `var(--token)`, or ''). */
  value: string
  /** Accessible label for the text input. */
  ariaLabel: string
  /** Accessible label for the swatch trigger. */
  swatchLabel: string
  placeholder?: string
  disabled?: boolean
  /** Token to hide from the picker (e.g. the token currently being edited). */
  excludeTokenId?: string
  /**
   * Offer the picker's gradient fill tabs and accept gradient strings as
   * valid input. Only pass this where the value actually lands on a property
   * that can hold a gradient (`background-image`) — `background-color` and
   * friends cannot, and offering it there would produce dead CSS.
   */
  gradients?: boolean
  /** Offer the picker's Image fill tab (background fills only). */
  images?: boolean
  /** Fires with the validated, committed value (on blur, swatch, or token pick). */
  onChange: (value: string) => void
  /**
   * Optional hover-preview hooks. When provided (and the `hoverPreview` editor
   * preference is on), hovering a colour-token suggestion transiently applies
   * its `var(--…)` reference via `onPreview`; leaving / closing the menu fires
   * `onClearPreview`.
   */
  onPreview?: (value: string) => void
  onClearPreview?: () => void
}

/**
 * ColorValueInput — the inspector's colour row.
 *
 * Renders `TokenizedColorField` in its `swatch` look: a chip, the value's
 * NAME, and a clear cross. There is no inline text field — typing a value and
 * searching tokens both happen inside the picker popout the chip opens — so
 * every colour row in the panel (Fill, Border, Shadow, Typography) reads the
 * same regardless of what kind of paint it holds.
 *
 * It renders NO surrounding label row, so each context supplies its own row
 * chrome: `ColorControl` wraps it in a `ControlRow`, while `BorderControl`
 * wraps it in its own `FieldRow`.
 *
 * (Distinct from `ColorsPanel/ColorValueField`, which uses the `field` look —
 * authoring a token's value there is a typing job.)
 */
export function ColorValueInput({
  id,
  value,
  ariaLabel,
  swatchLabel,
  placeholder,
  disabled,
  excludeTokenId,
  gradients = false,
  images = false,
  onChange,
  onPreview,
  onClearPreview,
}: ColorValueInputProps) {
  // Hover previews are gated by the shared "Preview suggestions on hover"
  // preference; when off we don't wire the preview callbacks through.
  const hoverPreviewEnabled = useEditorPreference('hoverPreview')
  const previewActive = hoverPreviewEnabled && onPreview != null

  // Defensive: clear any live preview if the preference flips off mid-hover.
  useEffect(() => {
    if (!hoverPreviewEnabled) onClearPreview?.()
  }, [hoverPreviewEnabled, onClearPreview])

  return (
    <TokenizedColorField
      look="swatch"
      id={id}
      value={value}
      disabled={disabled}
      inputLabel={ariaLabel}
      swatchLabel={swatchLabel}
      placeholder={placeholder}
      excludeTokenId={excludeTokenId}
      gradients={gradients}
      images={images}
      fieldSize="sm"
      monospace
      onTextChange={onChange}
      onTextBlur={() => {}}
      onSwatchChange={onChange}
      onTokenSelect={onChange}
      onTokenPreview={previewActive ? onPreview : undefined}
      onTokenPreviewClear={previewActive ? onClearPreview : undefined}
    />
  )
}
