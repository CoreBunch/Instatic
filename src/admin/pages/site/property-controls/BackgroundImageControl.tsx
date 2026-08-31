/**
 * BackgroundImageControl — property control for the CSS `background-image`
 * property on a style rule.
 *
 * Two modes plus an unset state, switched via a top-level SegmentedControl
 * (the same deselectable pattern used by the layout/display switcher): no
 * segment is pressed when nothing is set, and clicking the active segment
 * clears the value back to that unset state.
 *
 *   - **(unset)**  stored value: `''` (the publisher treats missing /
 *                  empty values as "do not emit"). Rendered as no pressed
 *                  segment — there is no explicit "None" button.
 *   - **Image**    stored value: `url('<URL>')`. Delegates to the existing
 *                  `MediaLibraryControl` (with its own Library / URL sub-toggle)
 *                  so this control inherits the media-library picker, asset
 *                  thumbnails, blurhash placeholders, edit-in-place, and the
 *                  custom-URL fallback for external CDNs. The control
 *                  translates between the field's CSS string (`url('x')`)
 *                  and the plain URL the library control expects.
 *   - **Custom**   stored value: any valid CSS `background-image` expression
 *                  (gradients, `image-set(...)`, ... — any string that isn't
 *                  `none`/`url(...)`). A gradient swatch (opens the rich
 *                  picker's Solid / Linear / Radial fill tabs) next to a raw
 *                  text input; the placeholder shows a gradient example as
 *                  the most common case.
 *
 * Mode detection on read (so an externally-set value lands on the right tab):
 *   - `''`  / `'none'`               → undefined (no segment pressed)
 *   - starts with `url(`             → 'image'
 *   - anything else (`linear-gradient(...)`, `radial-gradient(...)`, ...)
 *                                    → 'custom'
 *
 * Switching modes does NOT clear the stored value — the previous value stays
 * on the rule until the user enters a new one for the active mode (or clicks
 * the active segment, which clears explicitly). This means switching back to
 * the prior mode restores what was there.
 *
 * This is the single home for both imported `background-image` values (which
 * land here as `url('/uploads/...')` after `applyAssetRewrites`) and
 * user-authored values. The CSS importer (Phase 1+) already produces values
 * in the `url('...')` form so the picker recognises imported assets out of
 * the box.
 */
import { useState } from 'react'
import type { ControlProps } from './shared'
import { cn } from '@ui/cn'
import { SegmentedControl } from '@ui/components/SegmentedControl'
import { Input } from '@ui/components/Input'
import { ColorInput } from '@ui/components/ColorInput'
import { useEditorStore } from '@site/store/store'
import { MediaLibraryControl } from './MediaLibraryControl'
import styles from './BackgroundImageControl.module.css'

type BgImageMode = 'image' | 'custom'

const MODE_OPTIONS = [
  { value: 'image', label: 'Image', ariaLabel: 'Background image from media library' },
  { value: 'custom', label: 'Custom', ariaLabel: 'Custom CSS background (gradient, image-set, …)' },
] satisfies ReadonlyArray<{ value: BgImageMode; label: string; ariaLabel: string }>

// ---------------------------------------------------------------------------
// Value <-> mode helpers
// ---------------------------------------------------------------------------

/** Returns the matching mode, or `undefined` when nothing is set (unset state). */
function detectMode(value: string): BgImageMode | undefined {
  const trimmed = value.trim()
  if (!trimmed || trimmed.toLowerCase() === 'none') return undefined
  if (/^url\s*\(/i.test(trimmed)) return 'image'
  return 'custom'
}

/**
 * Pull the URL payload out of a `url('x')` / `url("x")` / `url(x)` string.
 * Returns '' when the input isn't a single url(...) expression.
 */
function extractUrlPayload(value: string): string {
  const match = value.trim().match(/^url\(\s*(['"]?)([^'")]+)\1\s*\)\s*$/i)
  return match?.[2]?.trim() ?? ''
}

function wrapUrl(payload: string): string {
  const cleaned = payload.trim()
  if (!cleaned) return ''
  // Always single-quote in storage so the publisher's emitter has one
  // canonical form. Strip any quotes the picker might have included.
  return `url('${cleaned.replace(/^['"]|['"]$/g, '')}')`
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

// The control intentionally ignores the schema-level placeholder. For
// background-image the upstream default placeholder is `none`, which is
// useless inside the custom text input — we always show a real gradient
// example instead. Image mode has its own picker affordances and never
// renders a free-form text input at this level.
type BackgroundImageControlProps = ControlProps<string>

export function BackgroundImageControl({
  propKey,
  value,
  onChange,
  label,
  isOverride,
  disabled,
}: BackgroundImageControlProps) {
  const cssValue = String(value ?? '')
  const setGradientPickerOpen = useEditorStore((s) => s.setGradientPickerOpen)
  const [mode, setMode] = useState<BgImageMode | undefined>(() => detectMode(cssValue))

  // Resync with the external value when it changes from elsewhere (preset
  // applied, breakpoint switched, import landed, ...). Without this the mode
  // tab can drift out of sync with the stored value. Done by adjusting state
  // during render (tracking the previous value) rather than in an effect —
  // the React-recommended pattern, which avoids the cascading re-render an
  // effect-driven setState would trigger.
  const [prevCssValue, setPrevCssValue] = useState(cssValue)
  if (cssValue !== prevCssValue) {
    setPrevCssValue(cssValue)
    setMode(detectMode(cssValue))
  }

  function handleModeChange(newMode: BgImageMode) {
    // Switching modes preserves the existing value; the inner control will
    // adopt it when it matches (URL for image, CSS for custom) or show empty
    // when it doesn't.
    setMode(newMode)
  }

  function handleClear() {
    // Clicking the active segment clears the value back to the unset state so
    // the publisher stops emitting `background-image`.
    setMode(undefined)
    onChange(propKey, '')
  }

  function handleImageUrlChange(_key: string, url: string) {
    onChange(propKey, url ? wrapUrl(url) : '')
  }

  function handleCustomChange(event: React.ChangeEvent<HTMLInputElement>) {
    onChange(propKey, event.target.value)
  }

  function handleGradientChange(next: string) {
    onChange(propKey, next)
  }

  // For the image picker we hand it the bare URL extracted from `url('...')`.
  // If the current cssValue isn't a url() (e.g. user is still in custom
  // mode visually but already switched tab), the picker sees empty.
  const imageUrl = mode === 'image' ? extractUrlPayload(cssValue) : ''

  return (
    /*
     * The mock's `.row:has(> .mediafield)`: a wrapping flex row — the label
     * keeps its column and the whole image field (mode tabs + picker) lives
     * in ONE control column beside it, wrapping under the label when the
     * dock is too narrow to give it a usable width.
     */
    <div className={cn(styles.imageRow, disabled && styles.imageRowDisabled)}>
      <label
        className={cn(styles.imageLabel, isOverride && styles.imageLabelOverride)}
        htmlFor={`ctrl-${propKey}`}
      >
        {label ?? propKey}
      </label>
      <div className={styles.imageField}>
        <SegmentedControl<BgImageMode>
          value={mode}
          options={MODE_OPTIONS}
          onChange={handleModeChange}
          onClear={handleClear}
          size="sm"
          fullWidth
          disabled={disabled}
          aria-label={`${label ?? propKey} mode`}
        />

        {mode === 'image' && (
          <MediaLibraryControl
            propKey={`${propKey}-image-url`}
            value={imageUrl}
            onChange={handleImageUrlChange}
            // Empty label suppresses MediaLibraryControl's inner labelRow
            // entirely — the row's own label already names the whole control.
            label=""
            isOverride={isOverride}
            disabled={disabled}
            layout="stacked"
            mediaKind="image"
          />
        )}

        {mode === 'custom' && (
          <div className={styles.customRow}>
            {/*
              The swatch opens the rich picker WITH its fill tabs, so a
              gradient can be built visually (stops, angle, per-stop colour)
              instead of hand-typing the CSS. The text input stays as the raw
              escape hatch — image-set(...) and other expressions the picker
              cannot edit remain typeable, and the picker simply starts from
              its defaults for values it cannot parse.
            */}
            <ColorInput
              value={cssValue}
              gradients
              disabled={disabled}
              onOpenChange={setGradientPickerOpen}
              onValueChange={handleGradientChange}
              aria-label={`${label ?? propKey} gradient`}
              fieldSize="xs"
            />
            <Input
              id={`ctrl-${propKey}-custom`}
              type="text"
              value={cssValue}
              // Always show a useful gradient example — the upstream placeholder
              // for `background-image` is `none`, which isn't a hint here.
              placeholder="linear-gradient(135deg, #f9fafb, #e5e7eb)"
              disabled={disabled}
              fieldSize="sm"
              onChange={handleCustomChange}
              aria-label={`${label ?? propKey} custom CSS`}
            />
          </div>
        )}
      </div>
    </div>
  )
}
