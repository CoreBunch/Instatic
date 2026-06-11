/**
 * Publisher prop coercion — soft boundary, never throws.
 *
 * `validateNodeProps` is the single call site that closes the module-props
 * boundary leak: authored props coming from the database can be stale,
 * missing, or lightly malformed. It normalises them to the schema's declared
 * shape before they reach the module's pure `render()`.
 *
 * Two-tier strategy (this runs once per node per render, so it dominates
 * publish time on large pages):
 *
 *   1. FAST PATH — if the schema is structurally "parse-stable" (see
 *      `fastPathEligible`) and the props already pass the cached compiled
 *      `Check`, return `rawProps` as-is. For such schema/value pairs the full
 *      `Value.Parse` pipeline is value-identity: Default and Convert are
 *      no-ops on a conforming value, Clean only strips unknown keys which the
 *      slow path's merge would restore anyway, and there are no Transforms to
 *      decode. Compiled `Check` is ~40-80× faster than interpreted
 *      `Value.Parse` and the clone is skipped entirely (module `render()`
 *      functions are pure consumers; `escapeProps` re-copies before any
 *      publisher-side mutation).
 *
 *   2. SLOW PATH — `Value.Parse` (Clone + Clean + Default + Convert + Check)
 *      exactly as before, for non-conforming values and for schemas where
 *      Check-pass does not imply Parse-identity.
 *
 * Design constraints:
 *   - SOFT boundary — exceptions from coercion are caught; never bubbles.
 *   - Unknown/injected keys survive — the fast path returns them untouched on
 *     `rawProps`; the slow path's merge is `{ ...rawProps, ...cleaned }` so
 *     publisher-injected fields (`_resolvedMediaByKey`, `_resolvedAutoSizes`)
 *     are never stripped.
 *   - Pass-through when no schema — modules without `propsSchema` are
 *     unaffected; the function is a no-op for them.
 */

import { Kind, OptionalKind, TransformKind } from '@sinclair/typebox'
import type { TSchema } from '@sinclair/typebox'
import { compiledCheck } from '@core/utils/typeboxCompiler'
import { parseValue } from '@core/utils/typeboxHelpers'
import type { AnyModuleDefinition } from './types'

/**
 * Leaf kinds for which a Check-passing value is exactly the Parse output:
 * none of them accepts `undefined` (so a present-but-undefined value can
 * never pass Check and then be replaced by a `default`), and Convert is the
 * identity on any value that already conforms.
 */
const ELIGIBLE_LEAF_KINDS = new Set([
  'String',
  'Number',
  'Integer',
  'Boolean',
  'Literal',
  'Null',
  'TemplateLiteral',
])

function isSchemaObject(value: unknown): value is TSchema {
  return typeof value === 'object' && value !== null
}

/**
 * Structural walk deciding whether `Check`-pass implies `Value.Parse`
 * value-identity for this schema. Conservative: anything we cannot reason
 * about confidently (Ref/This, Intersect, Date/custom kinds, symbol-less
 * plain-JSON schemas from the plugin boundary, cyclic schema objects) is
 * ineligible and stays on the slow path.
 *
 * The two hard disqualifiers the fast path must catch:
 *   1. An OPTIONAL property carrying a `default` — the absent key passes
 *      Check, but Value.Parse would materialize the default.
 *   2. A Transform anywhere — Value.Parse runs Decode; skipping it would
 *      hand the module the encoded value.
 *
 * `visiting` tracks the current walk path; revisiting an ancestor means the
 * schema object is literally cyclic, which TypeBox cannot compile — reject.
 * (Shared, non-cyclic subschemas are simply re-walked.)
 */
function walkEligible(schema: TSchema, visiting: Set<TSchema>): boolean {
  if (visiting.has(schema)) return false
  visiting.add(schema)
  try {
    if (TransformKind in schema) return false

    // TSchema types `[Kind]` as `string`, but schemas that crossed a JSON
    // boundary (plugin module packs) arrive symbol-less — guard at runtime.
    const kind: unknown = schema[Kind]
    if (typeof kind !== 'string') return false
    if (ELIGIBLE_LEAF_KINDS.has(kind)) return true

    switch (kind) {
      case 'Object': {
        // patternProperties is not produced by Type.Object — hand-built
        // hybrids get the conservative treatment.
        if ('patternProperties' in schema) return false
        const properties: unknown = schema.properties
        if (isSchemaObject(properties)) {
          for (const prop of Object.values(properties)) {
            if (!isSchemaObject(prop)) return false
            // Disqualifier 1: optional-with-default.
            if (OptionalKind in prop && 'default' in prop) return false
            if (!walkEligible(prop, visiting)) return false
          }
        }
        const additional: unknown = schema.additionalProperties
        if (isSchemaObject(additional) && !walkEligible(additional, visiting)) return false
        return true
      }
      case 'Record': {
        const pattern: unknown = schema.patternProperties
        if (!isSchemaObject(pattern)) return false
        for (const valueSchema of Object.values(pattern)) {
          if (!isSchemaObject(valueSchema)) return false
          if (!walkEligible(valueSchema, visiting)) return false
        }
        const additional: unknown = schema.additionalProperties
        if (isSchemaObject(additional) && !walkEligible(additional, visiting)) return false
        return true
      }
      case 'Array': {
        if ('contains' in schema) return false
        const items: unknown = schema.items
        return isSchemaObject(items) && walkEligible(items, visiting)
      }
      case 'Tuple': {
        const items: unknown = schema.items
        if (items === undefined) return true // zero-length tuple has no items
        if (!Array.isArray(items)) return false
        for (const item of items) {
          if (!isSchemaObject(item)) return false
          if (!walkEligible(item, visiting)) return false
        }
        return true
      }
      case 'Union': {
        const anyOf: unknown = schema.anyOf
        if (!Array.isArray(anyOf)) return false
        for (const member of anyOf) {
          if (!isSchemaObject(member)) return false
          if (!walkEligible(member, visiting)) return false
        }
        return true
      }
      case 'Unknown':
      case 'Any':
        // Clean/Convert/Default are identity for these kinds — UNLESS a
        // `default` annotation is present: Unknown/Any accept a literal
        // `undefined` value, which passes Check but which Value.Parse would
        // replace with the default.
        return !('default' in schema)
      default:
        return false
    }
  } finally {
    visiting.delete(schema)
  }
}

// Eligibility is a pure function of the schema object — computed once per
// schema for the app's lifetime. The allowlisted kinds are all compilable, so
// `compiledCheck` (which compiles on first use) cannot throw for an eligible
// schema.
const eligibilityCache = new WeakMap<TSchema, boolean>()

function fastPathEligible(schema: TSchema): boolean {
  const cached = eligibilityCache.get(schema)
  if (cached !== undefined) return cached
  const result = walkEligible(schema, new Set())
  eligibilityCache.set(schema, result)
  return result
}

/**
 * Coerce and default-fill `rawProps` against `def.propsSchema`.
 *
 * Behaviour:
 *   - No schema → return `rawProps` unchanged.
 *   - Schema fast-path eligible AND props already conform → return `rawProps`
 *     unchanged (value-identical to the slow path, minus the clone).
 *   - Schema present, coercion succeeds → `{ ...rawProps, ...cleanedProps }`.
 *     Known props are coerced/defaulted by Value.Parse; unknown keys from
 *     rawProps survive untouched.
 *   - Schema present, coercion fails → `{ ...rawProps, ...def.defaults }`.
 *     Falls back to module defaults for known keys, unknown keys still survive.
 */
export function validateNodeProps(
  def: AnyModuleDefinition,
  rawProps: Record<string, unknown>,
): Record<string, unknown> {
  if (!def.propsSchema) return rawProps

  // Tier 1: already-conforming props short-circuit through the cached
  // compiled validator — no clone, no interpreted Value.Parse.
  if (fastPathEligible(def.propsSchema) && compiledCheck(def.propsSchema, rawProps)) {
    return rawProps
  }

  try {
    // Tier 2: parseValue = Value.Parse: Clone + Clean + Default + Convert +
    // Check. Clean strips unknown keys from the result, so `cleaned` contains
    // only schema-known props. The spread merge below restores everything else.
    const cleaned = parseValue(def.propsSchema, rawProps) as Record<string, unknown>
    return { ...rawProps, ...cleaned }
  } catch (_err) {
    // Value.Parse threw — the input is unrecoverable for this schema even
    // after applying defaults and type coercions. Fall back to the module's
    // declared defaults, while still preserving any injected unknown keys.
    return { ...rawProps, ...def.defaults }
  }
}
