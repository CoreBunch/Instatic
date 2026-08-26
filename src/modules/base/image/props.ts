import { Type, type Static } from '@core/utils/typeboxHelpers'
import { HtmlAttributesPropSchemaOptions } from '@modules/base/shared/htmlAttributes'

export const ImagePropsSchema = Type.Object({
  src: Type.String({ default: '' }),
  loading: Type.Union([Type.Literal('lazy'), Type.Literal('eager')], { default: 'lazy' }),
  fetchPriority: Type.Union(
    [Type.Literal('auto'), Type.Literal('high'), Type.Literal('low')],
    { default: 'auto' },
  ),
  decoding: Type.Union(
    [Type.Literal('async'), Type.Literal('sync'), Type.Literal('auto')],
    { default: 'async' },
  ),
  /**
   * How the image fills a box the layout has already sized.
   *
   * `'default'` is a PROP value, not a CSS one: it emits nothing and leaves
   * the browser's own initial `fill`, which stretches the image to whatever
   * box it is given. `'cover'` and `'contain'` are the two answers that need
   * an explicit declaration.
   *
   * This is the knob that makes the asset's focus area do anything —
   * `object-position` is inert until something crops the image, and
   * `object-fit: cover` is what crops it.
   */
  objectFit: Type.Union(
    [Type.Literal('default'), Type.Literal('cover'), Type.Literal('contain')],
    { default: 'default' },
  ),
  htmlAttributes: Type.Record(Type.String(), Type.String(), HtmlAttributesPropSchemaOptions),
})

export type ImageStoredProps = Static<typeof ImagePropsSchema>
