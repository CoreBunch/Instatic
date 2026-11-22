import type { PageNode } from '@core/page-tree'
import { inlineTextEditSpec } from '@site/store/slices/inlineEditSlice'

/** The same literal text a user can edit in place on the canvas. */
export function layerTextPreview(node: PageNode): string {
  const spec = inlineTextEditSpec(node)
  const value = spec && node.props[spec.prop]
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : ''
}
