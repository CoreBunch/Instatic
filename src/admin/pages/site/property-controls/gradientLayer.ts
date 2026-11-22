import { isGradientImage, splitCssList } from '@ui/lib/cssValueList'

/** The inspector and canvas both edit the first gradient in the image stack. */
export function gradientLayer(image: unknown) {
  const css = String(image ?? '').trim()
  const layers = /^(?:none|initial|inherit|unset|revert(?:-layer)?)$/i.test(css) ? [] : splitCssList(css)
  const index = layers.findIndex(isGradientImage)
  return {
    value: index < 0 ? undefined : layers[index],
    replace(value: string | null) {
      const next = [...layers]
      next.splice(index < 0 ? 0 : index, index < 0 ? 0 : 1, ...(value ? [value] : []))
      return next.join(', ')
    },
  }
}
