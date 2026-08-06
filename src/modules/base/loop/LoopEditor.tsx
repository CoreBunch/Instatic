/**
 * base.loop editor preview component.
 *
 * Render strategy:
 *  - Empty (no children authored): show a hint placeholder so the author
 *    knows to drop a template subtree inside.
 *  - Has children: render them directly inside a single wrapper element
 *    whose tag is resolved from the author's `tag` / `customTag` props
 *    (defaults to `<div>`). The wrapper takes the user's class assignments
 *    via `mcClassName`. The canvas wrapper element is therefore the same
 *    element the publisher will emit (`<tag class="<user-classes>">…</tag>`
 *    from `renderLoop()`), so layout styles like `display: grid; gap: 24px`
 *    actually take effect on canvas the same way they will on the published page.
 *
 * The component intentionally adds no default visual styling — no inner
 * `display: contents` wrappers, no extra divs. Whatever the author
 * assigns is what they get.
 *
 * Component-only file so React Fast Refresh can hot-patch the canvas
 * without re-running module registration.
 */
import React from 'react'
import type { ModuleComponentProps } from '@core/module-engine'
import { CanvasModulePlaceholder } from '@ui/components/CanvasModulePlaceholder'
import { BoxStackSolidIcon } from 'pixel-art-icons/icons/box-stack-solid'
import { resolveHtmlTag } from '@modules/base/utils/htmlTag'
import { htmlAttributesForReact } from '@modules/base/shared/htmlAttributes'

export const LoopEditor: React.FC<ModuleComponentProps> = ({ props, children, mcClassName, nodeWrapperProps, nodeId }) => {
  const hasChildren = React.Children.count(children) > 0

  if (!hasChildren) {
    return (
      <CanvasModulePlaceholder
        {...nodeWrapperProps}
        className={mcClassName}
        icon={<BoxStackSolidIcon size={16} color="currentColor" />}
        label="Empty loop"
      />
    )
  }

  // Emit the same `data-instatic-loop` / `data-instatic-loop-page` attributes the
  // publisher writes in `renderLoop()`. Without these the canvas DOM
  // diverges from the published DOM and user CSS targeting
  // `[data-instatic-loop] > article` (a common grid-of-cards pattern) doesn't
  // match in the editor preview.
  // Author attributes are spread first, mirroring the published order. The
  // shared sanitiser reserves `data-instatic-*` / `data-canvas-*`, so the
  // wrapper's own attributes below cannot be overwritten either way.
  const Tag = resolveHtmlTag(props.tag, props.customTag)
  return React.createElement(
    Tag,
    {
      ...nodeWrapperProps,
      ...htmlAttributesForReact(props.htmlAttributes),
      className: mcClassName,
      'data-instatic-loop': nodeId,
      'data-instatic-loop-page': '1',
    },
    children,
  )
}
