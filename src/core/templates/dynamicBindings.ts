/**
 * Dynamic prop binding — resolves runtime values from the publisher's
 * entry stack into a node's static props at render time.
 *
 * The stack semantics are the heart of how templates compose with loops:
 *  - The publisher seeds the stack with the page's primary entry when
 *    rendering a single-entry content template.
 *  - The `base.loop` renderer renders each iteration against a fresh child
 *    `RenderConfig` whose `entryStack` is an immutable snapshot
 *    (`[...baseStack, item]`) — there is no in-place push/pop on a shared
 *    array, so a nested loop or VC ref in the body sees a stable per-iteration
 *    stack.
 *  - `dynamicBindings.source: 'currentEntry'` always reads the stack top,
 *    i.e. "the closest enclosing entity". Inside a loop nested in a
 *    template, that's the loop iteration; outside the loop it's still
 *    the template entry.
 *  - `dynamicBindings.source: 'parentEntry'` reads one frame below the
 *    top — useful inside a loop nested in a template, where you want to
 *    refer to the outer template entry from inside an iteration.
 *
 * Field lookup is generic: each `LoopItem` carries a `fields` map, and
 * the resolver simply reads `fields[binding.field]`. Format coercions
 * (e.g. markdown → HTML for body bindings with `format: 'html'`) happen
 * here as a thin shim so already-persisted bindings keep working without
 * the source needing to pre-render every variant.
 */

import { isValueSet, type DynamicPropBinding, type VisibilityCondition } from '@core/page-tree'
import { renderMarkdownToHtml } from '@core/markdown/renderMarkdown'
import { isRichtextPropKey } from '@core/sanitize'
import type { TemplateRenderDataContext } from './renderDataContext'

export type { TemplateRenderDataContext } from './renderDataContext'
import {
  containsTokens,
  interpolateTokens,
  readFrame,
  walkFieldPath,
} from './tokenInterpolation'

/**
 * Resolve a single binding to its runtime value.
 *
 * Dispatch by source:
 *   - `currentEntry` / `parentEntry` — read from the entry stack
 *     (top / second-from-top).
 *   - `page` / `site` / `route` — read from the corresponding
 *     named frame on the context.
 *
 * Returns `undefined` for fields that don't exist on the resolved frame
 * (or when the requested frame doesn't exist) — the caller decides
 * whether to fall back to the static prop or substitute an empty value.
 *
 * Field paths are dotted (`author.name`, `parent.slug`). The first
 * segment opens against the frame; subsequent segments walk plain
 * objects via `walkFieldPath`. Relation traversal is represented as ordinary
 * multi-segment paths against `currentEntry`.
 *
 * `readFrame` / `walkFieldPath` are shared with the token interpolator
 * — both live in `./tokenInterpolation.ts` to avoid duplication.
 */
function resolveBindingValue(
  binding: DynamicPropBinding,
  context: TemplateRenderDataContext,
): unknown {
  const frame = readFrame(binding.source, context)
  if (!frame) return undefined

  const value = walkFieldPath(frame, binding.field)

  // Markdown shim: when a binding targets the `body` cell (post-type rows)
  // or any `richText` field stored as markdown and the binding requests
  // `format: 'html'`, render markdown to HTML here so the module receives
  // ready-to-embed HTML rather than raw markdown. Tokens embedded inside
  // the body markdown are interpolated FIRST so authors can write
  // `Hello {currentEntry.title|untitled}` directly in a blog post body and
  // have it resolve against the same render context as page props.
  if (
    binding.format === 'html' &&
    typeof value === 'string' &&
    (binding.field === 'body' || binding.field === 'bodyMarkdown')
  ) {
    const interpolated = containsTokens(value) ? interpolateTokens(value, context) : value
    return renderMarkdownToHtml(interpolated)
  }

  return value
}

/**
 * Should this node render, given the data it is rendered against?
 *
 * Asked by the publisher, deliberately NOT by the editor canvas. Everywhere
 * else the two surfaces are kept identical, and this is the one place they
 * must differ: the canvas is where the node gets edited, and a node hidden
 * because the preview row happens to have no video is a node the author cannot
 * click. It stays on the canvas and the Properties panel shows its condition.
 *
 * Without a context the answer is always yes — a template rendered outside any
 * entry route has nothing to test against, and disappearing would be a strange
 * reading of "show this when the row has a video" on a page that has no row.
 */
export function isNodeVisible(
  node: { visibleWhen?: VisibilityCondition },
  context: TemplateRenderDataContext | undefined,
): boolean {
  const condition = node.visibleWhen
  if (!condition || !context) return true
  const frame = readFrame(condition.source, context)
  // An absent frame is an unset field, not an error: `currentEntry` outside a
  // loop has nothing to read, and "is not set" is then true.
  const isSet = frame ? isValueSet(walkFieldPath(frame, condition.field)) : false
  return condition.test === 'isSet' ? isSet : !isSet
}

/**
 * The implicit binding every `base.outlet` carries: its `html` prop is filled
 * with the current entry's markdown body, rendered to HTML. An outlet is, by
 * definition, the hole the current entry's body flows into — there is no UI to
 * set this and it is never persisted on the node. Resolving it here means ANY
 * outlet renders the body, including one a user drags onto a custom template by
 * hand (which carries no `dynamicBindings` overlay). Outside an entry route the
 * entry stack is empty, so `currentEntry.body` resolves to nothing and the
 * outlet stays empty — an `everywhere` layout's outlet then hosts a whole page
 * instead.
 */
const OUTLET_BODY_BINDING: DynamicPropBinding = {
  source: 'currentEntry',
  field: 'body',
  format: 'html',
}

/**
 * The bindings that actually apply to a node at render time: its persisted
 * `dynamicBindings` overlay plus the implicit outlet body binding for
 * `base.outlet`. Both the publisher (`renderNode`) and the editor canvas
 * (`NodeRenderer`) resolve through this so the two surfaces render identically.
 */
export function effectiveNodeBindings(node: {
  moduleId: string
  dynamicBindings?: Record<string, DynamicPropBinding>
}): Record<string, DynamicPropBinding> | undefined {
  if (node.moduleId === 'base.outlet') {
    return { ...node.dynamicBindings, html: OUTLET_BODY_BINDING }
  }
  return node.dynamicBindings
}

export function resolveDynamicProps(
  staticProps: Record<string, unknown>,
  bindings: Record<string, DynamicPropBinding> | undefined,
  context: TemplateRenderDataContext | undefined,
): Record<string, unknown> {
  if (!context) {
    // No render context — still pass through static props. Tokens inside
    // strings need a context to resolve, so they're left untouched.
    return staticProps
  }

  // Step 1: structured whole-prop binding overrides (for non-string props, this
  // is the only way a prop gets a dynamic value).
  let resolved: Record<string, unknown> | null = null
  if (bindings) {
    resolved = { ...staticProps }
    for (const [propKey, binding] of Object.entries(bindings)) {
      const value = resolveBindingValue(binding, context)
      if (value === undefined || value === null) {
        if (binding.fallback === 'empty') resolved[propKey] = ''
        continue
      }
      resolved[propKey] = value
    }
  }

  // Step 2: token interpolation for every string-typed prop value. Both
  // the original static props and any string overwritten by step 1 are
  // re-examined — a binding result might itself contain tokens
  // (uncommon but well-defined). The fast path inside
  // `interpolateTokens` skips work for strings with no token markers.
  //
  // Richtext shim: when the destination prop is a richtext/HTML key
  // (`html`, `richtext`, `*html`, `*richtext`), the interpolated value is
  // assumed to be markdown source — typically `{currentEntry.body}` for
  // post-type templates — and is rendered to HTML here. Plain richtext
  // values typed by the page author flow through untouched (token-free
  // values short-circuit before this code). This keeps token interpolation
  // working *and* keeps explicit
  // `dynamicBindings` with `format: 'html'` working (the binding resolver
  // already runs `renderMarkdownToHtml`; the resulting value contains no
  // tokens so the loop below does nothing).
  const target = resolved ?? staticProps
  let mutated = resolved !== null
  for (const key of Object.keys(target)) {
    const v = target[key]
    if (typeof v !== 'string') continue
    if (!containsTokens(v)) continue
    if (!mutated) {
      resolved = { ...staticProps }
      mutated = true
    }
    const interpolated = interpolateTokens(v, context)
    resolved![key] = isRichtextPropKey(key)
      ? renderMarkdownToHtml(interpolated)
      : interpolated
  }

  return resolved ?? staticProps
}
