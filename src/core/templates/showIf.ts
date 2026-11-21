/**
 * Show-if conditions: render an element only when a value in the render
 * context passes a test.
 *
 * Two values can be tested:
 *  - `query`: a parameter of the page address (`?commerce=plan_changed`),
 *    read from the route frame (`route.query.<name>`). A node with such a
 *    condition is request-dependent (detection rule 2c), so it renders at
 *    request time and is cached per query string, never per visitor.
 *  - `entry`: a field of the current loop item, or of the entry an entry
 *    template renders (`currentEntry.<name>`). Known at publish time, so the
 *    test runs once per iteration while the page is baked.
 *
 * Unlike a show-when rule this is not about who the visitor is, and it
 * protects nothing: anyone can add a query string. It decides whether one
 * element is part of the HTML, and the condition is applied on the server.
 * It is stored as the `showIf` prop, next to (and independent of) `showWhen`;
 * an element renders only when both pass.
 */

import { Type, safeParseValue, type Static } from '@core/utils/typeboxHelpers'
import type { TemplateRenderDataContext } from './renderDataContext'
import { readFrame } from './tokenInterpolation'

/**
 * Query parameter names and entry field paths a condition can name. Brackets
 * are not allowed, so a PHP-style `filter[status]` parameter cannot be tested.
 */
const CONDITION_NAME_PATTERN = '^[A-Za-z0-9_.-]{1,100}$'
export const SHOW_IF_NAME_REGEX = new RegExp(CONDITION_NAME_PATTERN)
export const SHOW_IF_VALUE_MAX_LENGTH = 500

export const ShowIfSchema = Type.Object(
  {
    source: Type.Union([Type.Literal('query'), Type.Literal('entry')]),
    name: Type.String({ pattern: CONDITION_NAME_PATTERN }),
    test: Type.Union([
      Type.Literal('equals'),
      Type.Literal('notEquals'),
      Type.Literal('filled'),
      Type.Literal('empty'),
    ]),
    /** Compared as text. Ignored by `filled` / `empty`. */
    value: Type.Optional(Type.String({ maxLength: SHOW_IF_VALUE_MAX_LENGTH })),
  },
  { additionalProperties: false },
)
export type ShowIf = Static<typeof ShowIfSchema>
export type ShowIfSource = ShowIf['source']
export type ShowIfTest = ShowIf['test']

/** The node prop a show-if condition is stored under. */
export const SHOW_IF_PROP_KEY = 'showIf'

/**
 * Read the show-if condition off a node's props. Absent means "always".
 * Present but unreadable means "never", the same safe side a show-when rule
 * takes: a condition nobody can read must not quietly show the element.
 */
export function readShowIf(props: Record<string, unknown>): ShowIf | 'never' | null {
  const raw = props[SHOW_IF_PROP_KEY]
  if (raw === undefined || raw === null) return null
  const parsed = safeParseValue(ShowIfSchema, raw)
  return parsed.ok ? parsed.value : 'never'
}

/**
 * The tested value as text: scalars as written, a list or object as empty or
 * not, anything missing as `''`. Equality never matches a list or object.
 */
function conditionText(value: unknown): { text: string; comparable: boolean } {
  if (value === null || value === undefined) return { text: '', comparable: true }
  if (typeof value === 'string') return { text: value, comparable: true }
  if (typeof value === 'number' || typeof value === 'boolean') return { text: String(value), comparable: true }
  if (Array.isArray(value)) return { text: value.length > 0 ? '1' : '', comparable: false }
  return { text: '1', comparable: false }
}

/**
 * Walk a dotted path through own properties only, so a name like
 * `constructor` or `__proto__` reads as missing rather than as a member of
 * `Object.prototype`.
 */
function ownPath(frame: Record<string, unknown>, path: string): unknown {
  let cursor: unknown = frame
  for (const segment of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor)) return undefined
    if (!Object.hasOwn(cursor, segment)) return undefined
    cursor = (cursor as Record<string, unknown>)[segment]
  }
  return cursor
}

function conditionValue(rule: ShowIf, context: TemplateRenderDataContext | undefined): unknown {
  if (!context) return undefined
  if (rule.source === 'query') {
    const query = context.route?.query
    return query && Object.hasOwn(query, rule.name) ? query[rule.name] : undefined
  }
  const frame = readFrame('currentEntry', context)
  return frame ? ownPath(frame, rule.name) : undefined
}

/** Is an element with this condition rendered in this context? */
export function showIfAllows(
  rule: ShowIf | 'never' | null,
  context: TemplateRenderDataContext | undefined,
): boolean {
  if (rule === null) return true
  if (rule === 'never') return false
  const { text, comparable } = conditionText(conditionValue(rule, context))
  switch (rule.test) {
    case 'filled':
      return text.trim() !== ''
    case 'empty':
      return text.trim() === ''
    case 'equals':
      return comparable && text === (rule.value ?? '')
    case 'notEquals':
      return !comparable || text !== (rule.value ?? '')
  }
}
