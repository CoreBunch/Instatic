import { useEffect, useState } from 'react'
import { isGradient } from '@ui/components/ColorPicker'
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
 * ColorValueInput — bare, self-contained colour value editor.
 *
 * Owns the draft-text buffer, blur validation (reverts CSS-invalid input), and
 * swatch/token commit policy around the presentational `TokenizedColorField`.
 * It renders NO surrounding label row, so each context supplies its own row
 * chrome: `ColorControl` wraps it in a `ControlRow`, while `BorderControl`
 * wraps it in its own `FieldRow` — keeping the colour field structurally
 * identical to its sibling width/style inputs.
 *
 * (Distinct from `ColorsPanel/ColorValueField`, which wraps `TokenizedColorField`
 * directly with live-edit semantics and no draft/validation buffer.)
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

  // Track the last upstream value we adopted so we can resync local edit state
  // when it changes (parent commit, undo, external patch, or — in BorderControl
  // — switching the active side). React's "store info from previous renders"
  // pattern, preferred over a useEffect+setState that would add a render pass.
  const [text, setText] = useState(value)
  const [lastSyncedValue, setLastSyncedValue] = useState(value)
  if (lastSyncedValue !== value) {
    setLastSyncedValue(value)
    setText(value)
  }

  function handleTextBlur() {
    const s = text.trim()
    const isTokenReference = /^var\(\s*--[a-z0-9_-]+\s*\)$/i.test(s)
    const cssSupportsColor =
      typeof CSS !== 'undefined' && typeof CSS.supports === 'function'
        ? CSS.supports('color', s)
        : true
    // A gradient is not a <color>, so the colour check above rejects it —
    // accept it explicitly wherever gradients are a legal value for this
    // field, otherwise a typed gradient would silently revert on blur.
    if (s === '' || isTokenReference || cssSupportsColor || (gradients && isGradient(s))) {
      onChange(s)
    } else {
      // Revert to last known-good value
      setText(value)
    }
  }

  function handleCommit(nextValue: string) {
    setText(nextValue)
    onChange(nextValue)
  }

  return (
    <TokenizedColorField
      id={id}
      value={text}
      disabled={disabled}
      inputLabel={ariaLabel}
      swatchLabel={swatchLabel}
      placeholder={placeholder ?? '#000000 or rgb(...)'}
      excludeTokenId={excludeTokenId}
      gradients={gradients}
      fieldSize="sm"
      monospace
      onTextChange={setText}
      onTextBlur={handleTextBlur}
      onSwatchChange={handleCommit}
      onTokenSelect={handleCommit}
      onTokenPreview={previewActive ? onPreview : undefined}
      onTokenPreviewClear={previewActive ? onClearPreview : undefined}
    />
  )
}
