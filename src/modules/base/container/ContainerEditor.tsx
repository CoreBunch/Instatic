/**
 * base.container editor preview component.
 *
 * Component-only file so React Fast Refresh can hot-patch edits without
 * re-running module registration. Tag resolution lives in the shared
 * `@modules/base/utils/htmlTag` helper — same code path the publisher
 * uses, so canvas + published HTML match exactly.
 *
 * Empty containers render the shared `CanvasModulePlaceholder` *inside*
 * the user's resolved tag so the empty state reads the same way as every
 * other module (image, video, content, loop, slot-outlet, …) while still
 * emitting the user's semantic element (`<section>`, `<header>`, etc.) on
 * canvas. The user's `mcClassName` stays on the outer tag where they
 * authored it, and `data-canvas-empty-container` stays on the outer
 * element so the canvas selection logic keeps treating the slot as a
 * pickable affordance.
 *
 * The empty-state affordance is suppressed once the container carries
 * authored styling: either a class (`mcClassName`) or inline styles from the
 * canvas node wrapper props. That means the author has given the element its
 * own look — decorative divs for background images, shapes, spacers — where
 * the "Empty container" icon + label would be visual noise that fights the
 * author's intended result. A styled empty container is already its own
 * affordance, so it renders as a bare element with no placeholder and no
 * `data-canvas-empty-container` marker.
 *
 * Void elements (`<br>`, `<hr>`, `<input>`, etc.) must never receive
 * children — not even the empty-container placeholder — because React
 * throws "X is a void element tag and must neither have 'children' nor use
 * 'dangerouslySetInnerHTML'" regardless of whether the child count is zero.
 * When the resolved tag is a void element, the element is rendered with no
 * children at all.
 */
import React from 'react'
import type { ModuleComponentProps } from '@core/module-engine'
import { resolveHtmlTag, VOID_HTML_ELEMENTS } from '@modules/base/utils/htmlTag'
import { htmlAttributesForReact } from '@modules/base/shared/htmlAttributes'
import { CanvasModulePlaceholder } from '@ui/components/CanvasModulePlaceholder'
import { ContainerSolidIcon } from 'pixel-art-icons/icons/container-solid'
import type { ContainerStoredProps } from './props'

export const ContainerEditor: React.FC<ModuleComponentProps<ContainerStoredProps>> = ({
  props,
  children,
  mcClassName,
  nodeWrapperProps,
}) => {
  const Tag = resolveHtmlTag(props.tag, props.customTag)
  const htmlAttrs = htmlAttributesForReact(props.htmlAttributes)

  // Void elements cannot have children. Render the element alone so React
  // does not throw. No empty-container placeholder is shown for void tags —
  // a self-closing element is its own affordance.
  if (VOID_HTML_ELEMENTS.has(Tag)) {
    return React.createElement(Tag, {
      ...nodeWrapperProps,
      ...htmlAttrs,
      className: mcClassName,
    })
  }

  // Only show the empty-state affordance for a truly bare container — no
  // children AND no author-applied styling. Styling supplies its own visual
  // affordance (background image, shape, spacer), so the placeholder would be
  // noise.
  const hasAuthoredStyling = !!mcClassName || Object.keys(nodeWrapperProps?.style ?? {}).length > 0
  const showPlaceholder = React.Children.count(children) === 0 && !hasAuthoredStyling

  return React.createElement(
    Tag,
    {
      ...nodeWrapperProps,
      ...htmlAttrs,
      className: mcClassName,
      'data-canvas-empty-container': showPlaceholder ? 'true' : undefined,
    },
    showPlaceholder ? (
      <CanvasModulePlaceholder
        icon={<ContainerSolidIcon size={16} color="currentColor" />}
        label="Empty container"
      />
    ) : children,
  )
}
