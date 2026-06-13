/**
 * base.image — responsive image module.
 *
 * Published HTML uses the full responsive pipeline produced by the
 * `prefetchMediaAssets` publisher pre-pass:
 *   - `srcset` built from `/uploads/<id>-w<width>.webp` variants only —
 *     the original never appears in srcset (see buildMediaSrcset)
 *   - `sizes` derived automatically from the layout by the publisher's
 *     `resolveAutoSizes` pre-pass (caps, fractions, grid columns); lazy
 *     images prefix `auto` so Chrome 121+ selects by actual rendered
 *     width. There is no user-facing `sizes` knob.
 *   - intrinsic `width` / `height` to prevent CLS
 *   - `loading` / `decoding` / `fetchpriority` perf hints
 *   - BlurHash data URL as a CSS background while the variant streams in
 *
 * When the publisher hasn't pre-resolved the asset (external URL, page
 * built pre-pipeline, editor canvas preview), we fall back to a plain
 * `<img src loading decoding>` so the module never breaks.
 */
import type { ModuleDefinition } from '@core/module-engine'
import type { RenderResolvedMedia } from '@core/publisher'
import { Type, Value } from '@core/utils/typeboxHelpers'
import type { Static } from '@core/utils/typeboxHelpers'
import { registry } from '@core/module-engine'
import { ImageSolidIcon } from 'pixel-art-icons/icons/image-solid'
import { escapeHtml, safeUrl } from '@modules/base/utils/escape'
import {
  htmlAttributesAttr,
  htmlAttributesControl,
  HtmlAttributesPropSchemaOptions,
} from '@modules/base/shared/htmlAttributes'
import { buildMediaSrcset } from '@modules/base/utils/mediaAttrs'
import { ImageEditor } from './ImageEditor'
import { shouldUseBlurPlaceholder } from './placeholder'

// ---------------------------------------------------------------------------
// Props schema — authored fields only. Publisher-injected fields (_resolved*)
// are NOT declared here; validateNodeProps merges them over the cleaned props
// so they survive the coercion step untouched.
// ---------------------------------------------------------------------------

const ImagePropsSchema = Type.Object({
  src: Type.String({ default: '' }),
  loading: Type.Union([Type.Literal('lazy'), Type.Literal('eager')], { default: 'lazy' }),
  /**
   * `fetchpriority` hint. Use `'high'` for hero / above-the-fold images,
   * `'low'` for offscreen marketing chrome.
   */
  fetchPriority: Type.Union(
    [Type.Literal('auto'), Type.Literal('high'), Type.Literal('low')],
    { default: 'auto' },
  ),
  decoding: Type.Union(
    [Type.Literal('async'), Type.Literal('sync'), Type.Literal('auto')],
    { default: 'async' },
  ),
  htmlAttributes: Type.Record(Type.String(), Type.String(), HtmlAttributesPropSchemaOptions),
})

/** Authored (stored) props — shape the user edits and the database persists. */
export type ImageStoredProps = Static<typeof ImagePropsSchema>

/**
 * Full render-time props. Intersects the authored schema shape with
 * publisher-injected fields that arrive after validateNodeProps runs.
 * The `_resolved*` fields are NOT in ImagePropsSchema — they bypass
 * schema cleaning via the `{ ...rawProps, ...cleaned }` merge in
 * validateNodeProps. The `& Record<string, unknown>` satisfies the
 * ModuleDefinition<TProps extends Record<string, unknown>> constraint.
 */
type ImageProps = ImageStoredProps & {
  /**
   * Internal: attached by the publisher's `prefetchMediaAssets` pass.
   * Map of prop key → resolved media. Not user-editable.
   * NOT in the schema (so the picker doesn't show it as a control row).
   */
  _resolvedMediaByKey?: Record<string, RenderResolvedMedia>
  /**
   * Internal: attached by the publisher's `resolveAutoSizes` pre-pass — the
   * layout-derived per-breakpoint `sizes` string (e.g.
   * `(max-width: 375px) 100vw, min(33.33vw - 16px, 410.67px)`). Absent when
   * nothing in the layout constrains the image.
   */
  _resolvedAutoSizes?: string
} & Record<string, unknown>

/**
 * Resolve the `sizes` attribute. There is no user knob — the publisher
 * derives the value from the layout it generates the CSS for.
 *
 * LAZY images prefix the `auto` keyword: browsers that implement
 * `sizes=auto` (Chrome 121+) select by the image's actual rendered width —
 * exact even where the publish-time estimate had to bail (flex rows);
 * others skip the unknown keyword and use the resolved fallback. The spec
 * only allows `auto` on `loading="lazy"`, so eager images emit the
 * fallback alone.
 */
function resolveSizes(autoResolved: string | undefined, lazy: boolean): string {
  const fallback = autoResolved ?? '100vw'
  return lazy ? `auto, ${fallback}` : fallback
}

/**
 * Convert a BlurHash string to a tiny inline SVG data URL suitable for a
 * CSS `background-image`. We render a 32×32 PNG via canvas — but we're in
 * a pure-render context (no DOM), so we approximate with an SVG
 * placeholder built from the BlurHash's first 6 chars (which encode the
 * DC term — i.e. the overall average colour). The full client-side
 * decode happens once the image hydrates; this server-side fallback just
 * paints a single-colour box so the layout doesn't flash empty.
 *
 * Why not the full 4×3 component decode? Pure render functions can't run
 * a canvas. Encoding a real SVG with multiple colour stops would require
 * porting `blurhash`' decoder to a string-builder. The single-colour DC
 * approximation is good enough for the first paint — by the time the
 * full image arrives a few hundred ms later, the difference is
 * imperceptible.
 */
function blurHashToCssBackground(hash: string): string | null {
  if (!hash || hash.length < 6) return null
  // BlurHash DC term decode: first 4 chars (after the size prefix) encode
  // the average sRGB color as a 24-bit integer in base83.
  const base83 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~'
  function decodeBase83(str: string): number {
    let value = 0
    for (const c of str) {
      const i = base83.indexOf(c)
      if (i === -1) return 0
      value = value * 83 + i
    }
    return value
  }
  const dc = decodeBase83(hash.slice(2, 6))
  const r = (dc >> 16) & 0xff
  const g = (dc >> 8) & 0xff
  const b = dc & 0xff
  // SVG attributes use DOUBLE quotes inside the template — `encodeURIComponent`
  // leaves `'` raw (it's in its safe-char set, per the spec) but DOES encode
  // `"` to `%22`. By using double quotes inside the SVG, we guarantee the
  // encoded URL contains zero raw quote chars and can safely sit inside the
  // single-quoted `url('…')` and the outer double-quoted `style="…"`.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1" fill="rgb(${r},${g},${b})"/></svg>`
  return `url('data:image/svg+xml,${encodeURIComponent(svg)}')`
}

export const ImageModule: ModuleDefinition<ImageProps> = {
  id: 'base.image',
  name: 'Image',
  description: 'A responsive image.',
  category: 'Media',
  version: '4.0.0',
  icon: ImageSolidIcon,
  trusted: true,
  canHaveChildren: false,

  propsSchema: ImagePropsSchema,

  schema: {
    src: { type: 'image', label: 'Image' },
    loading: {
      type: 'select',
      label: 'Loading',
      options: [
        { label: 'Lazy', value: 'lazy' },
        { label: 'Eager', value: 'eager' },
      ],
    },
    fetchPriority: {
      type: 'select',
      label: 'Fetch priority',
      options: [
        { label: 'Auto', value: 'auto' },
        { label: 'High (above the fold)', value: 'high' },
        { label: 'Low (offscreen)', value: 'low' },
      ],
    },
    decoding: {
      type: 'select',
      label: 'Decoding',
      options: [
        { label: 'Async', value: 'async' },
        { label: 'Sync', value: 'sync' },
        { label: 'Auto', value: 'auto' },
      ],
    },
    htmlAttributes: htmlAttributesControl(),
  },

  // Single source of truth: defaults are derived from the schema's `default`
  // annotations so they can never diverge from the declared shape.
  defaults: Value.Create(ImagePropsSchema),

  component: ImageEditor,

  htmlTag: 'img',

  render: (props) => {
    const src = safeUrl(props.src)
    if (!src) return { html: '' }
    const htmlAttrs = htmlAttributesAttr(props.htmlAttributes)

    // Alt text comes exclusively from the library asset — the library is
    // the single source of truth for accessibility metadata. Edited in
    // the Media viewer (asset row), never as a per-instance module prop.
    //
    // The resolved-media payload is raw (not run through the publisher's
    // `escapeProps`), so we HTML-escape here at the boundary.
    const media = props._resolvedMediaByKey?.src
    const alt = escapeHtml(media?.altText?.trim() ?? '')

    const loading = props.loading === 'eager' ? 'eager' : 'lazy'
    const decoding = props.decoding === 'sync' ? 'sync' : props.decoding === 'auto' ? 'auto' : 'async'
    const fetchPriority = props.fetchPriority === 'high'
      ? 'high'
      : props.fetchPriority === 'low' ? 'low' : 'auto'

    // `buildMediaSrcset` already runs each variant path through `safeUrl`
    // (which HTML-escapes + sanitises). No extra escape needed.
    const srcset = media ? buildMediaSrcset(media) : null
    // `_resolvedAutoSizes` comes from the publisher pre-pass and is a pure
    // attribute-safe string (numbers, media-query keywords, CSS math
    // functions), so no further escape is needed.
    const sizes = srcset
      ? resolveSizes(props._resolvedAutoSizes, loading === 'lazy')
      : null
    const width = media?.width ?? null
    const height = media?.height ?? null
    const blurBg = media?.blurHash && shouldUseBlurPlaceholder(media.blurHash, media.mimeType)
      ? blurHashToCssBackground(media.blurHash)
      : null

    // Build the attribute string. Each attribute is conditionally appended
    // so the output is clean (no `width="null"` or empty `srcset=""`).
    const attrs: string[] = [`src="${src}"`, `alt="${alt}"`]
    if (srcset) attrs.push(`srcset="${srcset}"`)
    if (sizes) attrs.push(`sizes="${sizes}"`)
    if (width !== null) attrs.push(`width="${width}"`)
    if (height !== null) attrs.push(`height="${height}"`)
    attrs.push(`loading="${loading}"`)
    attrs.push(`decoding="${decoding}"`)
    if (fetchPriority !== 'auto') attrs.push(`fetchpriority="${fetchPriority}"`)
    // BlurHash background sits BEHIND the image via inline style. Once
    // the variant loads, the opaque <img> covers it. Skipped when
    // loading="eager" — those are above-the-fold images where the user
    // wants the real pixels ASAP, and the blur-then-flash effect is more
    // distracting than helpful at the top of the page.
    if (blurBg && loading === 'lazy') {
      attrs.push(`style="background-image:${blurBg};background-size:cover;background-position:center"`)
    }

    return { html: `<img${htmlAttrs} ${attrs.join(' ')}>` }
  },
}

registry.registerOrReplace(ImageModule)
