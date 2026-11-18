/**
 * base.button editor preview component.
 *
 * Component-only file so React Fast Refresh can hot-patch edits without
 * re-running module registration.
 *
 * The label is edited via the Properties panel and inline on the canvas
 * (double-click → the element itself becomes contentEditable; see
 * `inlineEditableElementProps`).
 */
import React from 'react'
import type { ModuleComponentProps } from '@core/module-engine'
import { anchorHtmlAttributes } from '@modules/base/shared/anchorTarget'
import { htmlAttributesForReact } from '@core/htmlAttributes'
import { inlineEditableElementProps } from '@modules/base/shared/inlineText'
import { resolveButtonAnchor } from './anchor'
import type { ButtonStoredProps } from './props'

export const ButtonEditor: React.FC<ModuleComponentProps<ButtonStoredProps>> = ({
  props,
  mcClassName,
  nodeWrapperProps,
  inlineEdit,
}) => {
  const label = props.label || 'Button'
  const anchor = resolveButtonAnchor(props.href)
  // React.createElement (not JSX) so the editable element's generic
  // `Ref<HTMLElement>` is accepted — matching TextEditor / LinkEditor.
  if (anchor) {
    const { attributes, rel } = anchorHtmlAttributes(props.htmlAttributes, props.target)
    return React.createElement(
      'a',
      {
        ...nodeWrapperProps,
        ...attributes,
        href: anchor.href,
        target: props.target,
        rel: rel ?? undefined,
        className: mcClassName,
        ...(inlineEdit ? inlineEditableElementProps(inlineEdit) : {}),
      },
      inlineEdit ? undefined : label,
    )
  }
  return React.createElement(
    'button',
    {
      ...nodeWrapperProps,
      ...htmlAttributesForReact(props.htmlAttributes),
      type: 'button',
      className: mcClassName,
      // A disabled button can't be focused/edited — never disable while editing.
      disabled: inlineEdit ? undefined : props.disabled,
      ...(inlineEdit ? inlineEditableElementProps(inlineEdit) : {}),
    },
    inlineEdit ? undefined : label,
  )
}
