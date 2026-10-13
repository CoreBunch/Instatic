import { Type, type Static } from '@core/utils/typeboxHelpers'

/** One source occurrence of a CSS grouping block, including anonymous layers. */
export const CSSRuleGroupSchema = Type.Union([
  Type.Object({
    id: Type.String(),
    kind: Type.Literal('layer'),
    name: Type.Optional(Type.String()),
  }),
  Type.Object({
    id: Type.String(),
    kind: Type.Literal('context'),
    contextId: Type.String(),
  }),
])
export type CSSRuleGroup = Static<typeof CSSRuleGroupSchema>

/** Structured stylesheet side effects; no arbitrary CSS text is accepted. */
export const CSSAtRuleSchema = Type.Union([
  Type.Object({ kind: Type.Literal('group'), group: CSSRuleGroupSchema }),
  Type.Object({
    kind: Type.Literal('layer-order'),
    names: Type.Array(Type.String(), { minItems: 1 }),
  }),
  Type.Object({
    kind: Type.Literal('property'),
    name: Type.String(),
    syntax: Type.String(),
    inherits: Type.Boolean(),
    initialValue: Type.Optional(Type.String()),
  }),
])
export type CSSAtRule = Static<typeof CSSAtRuleSchema>

// CSS identifiers can contain escapes (including a hex escape's optional
// whitespace terminator); a layer path is one or more identifiers joined by dots.
const CSS_ESCAPE = String.raw`\\(?:[0-9a-fA-F]{1,6}[ \t\r\n\f]?|[^0-9a-fA-F\r\n\f])`
const CSS_NAME_START = String.raw`(?:[_a-zA-Z\u0080-\uFFFF]|${CSS_ESCAPE})`
const CSS_NAME_CHAR = String.raw`(?:[_a-zA-Z0-9\-\u0080-\uFFFF]|${CSS_ESCAPE})`
const CSS_IDENT = String.raw`(?:--${CSS_NAME_CHAR}*|-?${CSS_NAME_START}${CSS_NAME_CHAR}*)`
const CSS_LAYER_NAME = new RegExp(`^${CSS_IDENT}(?:\\.${CSS_IDENT})*$`, 'u')

export function isValidCssLayerName(name: string): boolean {
  return CSS_LAYER_NAME.test(name) && !name.includes('</')
}
