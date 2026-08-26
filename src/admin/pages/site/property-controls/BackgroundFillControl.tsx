/**
 * BackgroundFillControl — the unified "fill" editor for the Background section.
 *
 * CSS has no single fill property: a solid colour belongs on
 * `background-color`, a gradient on `background-image`. Visual editors that
 * offer one swatch (Figma, Framer) hide that split, and users expect the same
 * here — open the background swatch, switch to Linear, get a gradient. A
 * plain `ColorControl` cannot do that: writing `linear-gradient(...)` into
 * `background-color` is dead CSS the browser drops on the floor.
 *
 * So this control owns BOTH properties and routes each edit to whichever one
 * is actually correct:
 *
 *   - solid    → `background-color`. Also clears `background-image` when it
 *                currently holds a GRADIENT (that gradient is the thing the
 *                user is replacing). An image `url(...)` is deliberately left
 *                alone — a colour behind an image is a legitimate pairing,
 *                and the Background image row below still owns it.
 *   - gradient → `background-image`, clearing `background-color` so a leftover
 *                colour cannot paint over the gradient it replaced.
 *
 * Both keys travel in ONE patch, so the swap is a single undo step and the
 * canvas never renders an in-between frame with both set.
 *
 * Reading back is the mirror: a gradient on `background-image` wins over
 * `background-color`, because that is what the element actually paints.
 */

import { isGradient } from '@ui/components/ColorPicker'
import type { CSSPropertyBag } from '@core/page-tree'
import { ControlRow } from '@ui/components/ControlRow'
import type { PropertyControlLayout } from '@core/module-engine'
import { ColorValueInput } from './ColorValueInput'

interface BackgroundFillControlProps {
  /** Always `backgroundColor` — the row this control stands in for. */
  propKey: string
  label?: string
  /** Current `background-color`. */
  colorValue: string
  /** Current `background-image` — only a gradient here is part of the fill. */
  imageValue: string
  placeholder?: string
  isOverride?: boolean
  disabled?: boolean
  layout?: PropertyControlLayout
  /** Applies both keys in one patch (one store commit, one undo entry). */
  onChangeMany: (patch: Partial<CSSPropertyBag>) => void
  /**
   * Hover-preview hooks, forwarded from the row. Previews are colour-only:
   * the suggestion menu offers colour tokens, never gradients.
   */
  onPreview?: (value: string) => void
  onClearPreview?: () => void
}

export function BackgroundFillControl({
  propKey,
  label,
  colorValue,
  imageValue,
  placeholder,
  isOverride,
  disabled,
  layout,
  onChangeMany,
  onPreview,
  onClearPreview,
}: BackgroundFillControlProps) {
  const imageIsGradient = isGradient(imageValue)
  const fillValue = imageIsGradient ? imageValue : colorValue

  function handleChange(next: string) {
    if (isGradient(next)) {
      onChangeMany({ backgroundImage: next, backgroundColor: undefined })
      return
    }
    onChangeMany({
      backgroundColor: next,
      // Only retire a gradient — never an image the user picked separately.
      ...(imageIsGradient ? { backgroundImage: undefined } : {}),
    })
  }

  return (
    <ControlRow
      propKey={propKey}
      label={label}
      inputId={`ctrl-${propKey}-text`}
      layout={layout}
      isOverride={isOverride}
      disabled={disabled}
    >
      <ColorValueInput
        id={`ctrl-${propKey}-text`}
        value={fillValue}
        disabled={disabled}
        gradients
        ariaLabel={label ?? propKey}
        swatchLabel={`${label ?? propKey} fill`}
        placeholder={placeholder}
        onChange={handleChange}
        onPreview={onPreview}
        onClearPreview={onClearPreview}
      />
    </ControlRow>
  )
}
