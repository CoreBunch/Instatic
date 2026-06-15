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

  // Editing: the element becomes the contentEditable surface (content seeded
  // from the frozen initial HTML inside inlineEditableElementProps). `tag: none`
  // has no published element, but an active edit session still needs a host —
  // a `<span>` is the minimal one. This branch is effectively unreachable for
  // tag:none from the canvas: the display branch below renders no element, so
  // there is nothing to double-click to start a session.
  if (inlineEdit) {
    const EditTag = (tag === 'none' ? 'span' : tag) as React.ElementType
    return React.createElement(EditTag, {
      ...nodeWrapperProps,
      ...(tag === 'none' ? {} : htmlAttributesForReact(props.htmlAttributes)),
      className: mcClassName,
      ...inlineEditableElementProps(inlineEdit),
    })
  }

  // Display: `tag: none` emits NO element, exactly like the publisher
  // (`src/modules/base/text/index.ts` render() returns bare text). Wrapping it
  // in any element here would let descendant selectors such as `.parent span`
  // paint the text in the canvas while leaving the published page untouched —
  // a canvas/publish fidelity break. Bare text keeps the canvas DOM identical
  // to the published DOM. The cost: a tag:none node owns no element, so it has
  // no in-canvas selection ring / hover / inline-edit; it is selected and
  // edited via the Layers + Properties panels instead.
  if (tag === 'none') {
    return <BareText text={props.text ?? ''} />
  }

  // Display: escaped text with newlines as <br>, matching the publisher.
  const html = rawTextToBreakHtml(props.text || 'Text')
  const Tag = tag as React.ElementType
  return React.createElement(Tag, {
    ...nodeWrapperProps,
    ...htmlAttributesForReact(props.htmlAttributes),
    className: mcClassName,
    dangerouslySetInnerHTML: { __html: html },
  })
}

/**
 * Bare text with `\n` → `<br>` breaks and NO wrapping element — a fragment, so
 * it adds no host element to the canvas DOM. Mirrors the publisher's
 * `textToBreakHtml` output for `tag: none` (bare text + `<br>`); React escapes
 * each text segment, matching the publisher's pre-escaped output.
 */
const BareText: React.FC<{ text: string }> = ({ text }) => (
  <>
    {text.split('\n').map((segment, i) => (
      <React.Fragment key={i}>
        {i > 0 ? <br /> : null}
        {segment}
      </React.Fragment>
    ))}
  </>
)
