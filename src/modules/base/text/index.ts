/**
 * base.text — unified semantic text module.
 *
 * Content and semantic tag are module settings; visual typography belongs to
 * class styles. Emits a bare semantic element with no default class or CSS.
 */
import { registry } from '@core/module-engine'
import type { ModuleDefinition } from '@core/module-engine'
import { TextStartTIcon } from 'pixel-art-icons/icons/text-start-t'
import { Type, Value, type Static } from '@core/utils/typeboxHelpers'
import {
  htmlAttributesAttr,
  htmlAttributesControl,
  HtmlAttributesPropSchemaOptions,
} from '@modules/base/shared/htmlAttributes'
import { textToBreakHtml } from '@modules/base/shared/inlineText'
import { TextEditor } from './TextEditor'
import { normalizeTag } from './tags'

const TextPropsSchema = Type.Object({
  text: Type.String({ default: 'Add your text here.' }),
  tag: Type.Union(
    [
      Type.Literal('p'),
      Type.Literal('none'),
      Type.Literal('h1'),
      Type.Literal('h2'),
      Type.Literal('h3'),
      Type.Literal('h4'),
      Type.Literal('h5'),
      Type.Literal('h6'),
      Type.Literal('span'),
      Type.Literal('div'),
      Type.Literal('small'),
      Type.Literal('strong'),
      Type.Literal('em'),
    ],
    { default: 'p' },
  ),
  htmlAttributes: Type.Record(Type.String(), Type.String(), HtmlAttributesPropSchemaOptions),
})

export type TextStoredProps = Static<typeof TextPropsSchema>

export const TextModule: ModuleDefinition<TextStoredProps> = {
  id: 'base.text',
  name: 'Text',
  description: 'A semantic text element.',
  category: 'Typography',
  version: '2.0.0',
  icon: TextStartTIcon,
  trusted: true,
  canHaveChildren: false,
  inlineTextEdit: { prop: 'text', multiline: true },

  schema: {
    text: { type: 'textarea', label: 'Text', rows: 4, placeholder: 'Enter text...' },
    // `tag` is a `select`, which defaults to category: 'layout' by the
    // type-based heuristic. Override to 'content' — a copy editor changing
    // a heading from h2 to h3 is editorial, not structural.
    tag: {
      type: 'select',
      label: 'Tag',
      category: 'content',
      options: [
        { label: 'Paragraph', value: 'p' },
        { label: 'None', value: 'none' },
        { label: 'Heading 1', value: 'h1' },
        { label: 'Heading 2', value: 'h2' },
        { label: 'Heading 3', value: 'h3' },
        { label: 'Heading 4', value: 'h4' },
        { label: 'Heading 5', value: 'h5' },
        { label: 'Heading 6', value: 'h6' },
        { label: 'Span', value: 'span' },
        { label: 'Div', value: 'div' },
        { label: 'Small', value: 'small' },
        { label: 'Strong', value: 'strong' },
        { label: 'Emphasis', value: 'em' },
      ],
    },
    htmlAttributes: htmlAttributesControl(),
  },

  propsSchema: TextPropsSchema,

  defaults: Value.Create(TextPropsSchema),

  component: TextEditor,

  htmlTag: (props) => {
    const tag = normalizeTag(props.tag)
    return tag === 'none' ? null : tag
  },

  render: (props) => {
    // props.text is pre-escaped by escapeProps — only turn newlines into the
    // hard <br> breaks the author typed (sanitizer allows <br>).
    const text = textToBreakHtml(String(props.text))
    const tag = normalizeTag(props.tag)
    if (tag === 'none') {
      return { html: text }
    }
    const attrs = htmlAttributesAttr(props.htmlAttributes)
    return {
      html: `<${tag}${attrs}>${text}</${tag}>`,
    }
  },
}

registry.registerOrReplace(TextModule)
