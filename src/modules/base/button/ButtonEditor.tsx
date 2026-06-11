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
import { anchorRel } from '@modules/base/shared/anchorTarget'
import { htmlAttributesForReact } from '@modules/base/shared/htmlAttributes'
import { inlineEditableElementProps } from '@modules/base/shared/inlineText'
import { resolveButtonAnchor } from './anchor'
import type { ButtonStoredProps } from './index'

export const ButtonEditor: React.FC<ModuleComponentProps<ButtonStoredProps>> = ({
  props,
  mcClassName,
  nodeWrapperProps,
  inlineEdit,
}) => {
  const label = props.label || 'Button'
  const htmlAttrs = htmlAttributesForReact(props.htmlAttributes)
  const anchor = resolveButtonAnchor(props.href)
  // React.createElement (not JSX) so the editable element's generic
  // `Ref<HTMLElement>` is accepted — matching TextEditor / LinkEditor.
  if (anchor) {
    return React.createElement(
      'a',
      {
        ...nodeWrapperProps,
        ...htmlAttrs,
        href: anchor.href,
        target: props.target,
        rel: anchorRel(props.target) ?? undefined,
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
      ...htmlAttrs,
      type: 'button',
      className: mcClassName,
      // A disabled button can't be focused/edited — never disable while editing.
      disabled: inlineEdit ? undefined : props.disabled,
      ...(inlineEdit ? inlineEditableElementProps(inlineEdit) : {}),
    },
    inlineEdit ? undefined : label,
  )
}
