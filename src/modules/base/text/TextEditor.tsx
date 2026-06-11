/**
 * base.text editor preview component.
 *
 * Component-only file so React Fast Refresh can hot-patch edits without
 * re-running module registration. Per Constraint #309, this file MUST NOT
 * export non-component values — `normalizeTag` and the tag vocabulary live in
 * the shared `./tags` module that both this file and `index.ts` import.
 *
 * Text renders through `dangerouslySetInnerHTML` (escaped value with `\n` →
 * `<br>`) so the canvas shows the same hard breaks the published page does.
 *
 * Inline editing (double-click): when `inlineEdit` is present, THIS element
 * IS the editor — it becomes `contentEditable` and the canvas reads the text
 * back out of it. There is no overlay, so the editing surface is byte-identical
 * to the published element.
 */
import React from 'react'
import type { ModuleComponentProps } from '@core/module-engine'
import { htmlAttributesForReact } from '@modules/base/shared/htmlAttributes'
import { inlineEditableElementProps, rawTextToBreakHtml } from '@modules/base/shared/inlineText'
import { normalizeTag } from './tags'
import type { TextStoredProps } from './index'

export const TextEditor: React.FC<ModuleComponentProps<TextStoredProps>> = ({
  props,
  mcClassName,
  nodeWrapperProps,
  inlineEdit,
}) => {
  const tag = normalizeTag(props.tag)
  const elementTag = tag === 'none' ? 'span' : tag
  const Tag = elementTag as React.ElementType

  // Editing: the element becomes the contentEditable surface (content seeded
  // from the frozen initial HTML inside inlineEditableElementProps).
  if (inlineEdit) {
    return React.createElement(Tag, {
      ...nodeWrapperProps,
      ...(tag === 'none' ? {} : htmlAttributesForReact(props.htmlAttributes)),
      className: mcClassName,
      ...inlineEditableElementProps(inlineEdit),
    })
  }

  // Display: escaped text with newlines as <br>, matching the publisher.
  const html = rawTextToBreakHtml(props.text || 'Text')
  return React.createElement(Tag, {
    ...nodeWrapperProps,
    ...(tag === 'none' ? {} : htmlAttributesForReact(props.htmlAttributes)),
    className: mcClassName,
    dangerouslySetInnerHTML: { __html: html },
  })
}
