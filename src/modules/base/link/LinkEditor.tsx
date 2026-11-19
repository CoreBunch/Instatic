/**
 * base.link editor preview component.
 *
 * Component-only file so React Fast Refresh can hot-patch edits without
 * re-running module registration. The children-vs-text fallback and the
 * `rel` decision are shared with the publisher via `./content` and
 * `@modules/base/shared/anchorTarget`, so the canvas cannot drift from the
 * published markup.
 */
import React from 'react'
import type { ModuleComponentProps } from '@core/module-engine'
import { anchorHtmlAttributes } from '@modules/base/shared/anchorTarget'
import { inlineEditableElementProps } from '@modules/base/shared/inlineText'
import { linkUsesChildren } from './content'
import type { LinkStoredProps } from './props'

export const LinkEditor: React.FC<ModuleComponentProps<LinkStoredProps>> = ({ props, children, mcClassName, nodeWrapperProps, inlineEdit }) => {
  const childCount = Array.isArray(children) ? children.length : children != null ? 1 : 0
  // Inline editing only starts on a childless link (text mode), so when
  // `inlineEdit` is set the element edits its `text` prop in place.
  const content = linkUsesChildren(childCount) ? children : (props.text ?? 'Link text')
  const { attributes, rel } = anchorHtmlAttributes(props.htmlAttributes, props.target)
  return React.createElement(
    'a',
    {
      ...nodeWrapperProps,
      ...attributes,
      href: props.href || '#',
      target: props.target,
      rel: rel ?? undefined,
      className: mcClassName,
      ...(inlineEdit ? inlineEditableElementProps(inlineEdit) : {}),
    },
    inlineEdit ? undefined : content,
  )
}
