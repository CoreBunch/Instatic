/**
 * TypeBox helpers — the layer that maps Zod's chained ergonomics
 * (`.catch()`, `.transform()`, `.refine()`) onto TypeBox's data-first
 * schema model.
 *
 * Why these exist
 * ---------------
 * TypeBox schemas are JSON Schema documents — pure data, no methods. That
 * makes them fast and serializable, but it means there is no native
 * `.catch(default)` for soft-fallback parsing of corrupted persisted data,
 * no `.transform()` for in-line shape massaging, and no `.refine()` for
 * cross-field invariants. We add those concerns as *helpers* that wrap
 * TypeBox validation. Hot `Check` / `Decode` / `Errors` paths go through
 * the cached TypeCompiler helpers in `typeboxCompiler.ts`; `parseValue`
 * intentionally keeps TypeBox's `Value.Parse` pipeline for defaulting,
 * conversion, cleaning, assertion, and decoding.
 *
 * Public API
 * ----------
 * - `withFallback(schema, fallback)` — annotate a schema with a default value
 *   used when validation fails. Equivalent to Zod's `.catch()`.
 * - `parseValue(schema, value)` — strict parse; throws on invalid input.
 * - `safeParseValue(schema, value)` — discriminated-union result type.
 * - `Static<T>` — re-exported from TypeBox for type inference (mirror of
 *   `z.infer<T>`).
 */

import { Type } from '@sinclair/typebox'
import type { TSchema, Static as TBStatic } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import {
  compiled,
  compiledFormatValueErrors,
  compiledSafeParseValue,
} from './typeboxCompiler'

export { Type, Value }
export type { TSchema }
export type Static<T extends TSchema> = TBStatic<T>
export { compiled }

// Sentinel used to attach a fallback to any schema. Picked up by
// `parseWithFallbackAnnotation`. We use a Symbol so it never clashes with
// JSON Schema's own keywords.
const FALLBACK = Symbol('typebox-fallback')

interface SchemaWithFallback<T extends TSchema> {
  [FALLBACK]?: TBStatic<T>
}

type SchemaResult<T extends TSchema> =
  | { ok: true; value: TBStatic<T> }
  | { ok: false; errors: ReadonlyArray<{ path: string; message: string }> }

/**
 * Attach a fallback value to a schema. The schema itself is unchanged for
 * validation purposes; the fallback is consulted only by helpers that
 * explicitly read the annotation.
 *
 * Equivalent semantics to Zod's `Schema.catch(value)`.
 */
export function withFallback<T extends TSchema>(schema: T, fallback: TBStatic<T>): T {
  const annotated = schema as T & SchemaWithFallback<T>
  annotated[FALLBACK] = fallback
  return annotated
}

/**
 * Strict parse. Throws if the value does not match the schema. Use at HTTP
 * boundaries where invalid input is genuinely an error.
 *
 * Returns a value that has been *coerced* through the schema (defaults
 * applied, transforms run if any). For pure validation without coercion use
 * `safeParseValue`, `filterArray`, or the compiled helpers directly.
 */
export function parseValue<T extends TSchema>(schema: T, value: unknown): TBStatic<T> {
  // Value.Parse runs Default + Convert + Clean + Decode + Check. That's the
  // closest match to Zod's `.parse()` semantics — it both validates and
  // produces the canonical output shape.
  return Value.Parse(schema, value) as TBStatic<T>
}

/**
 * Discriminated-union result, equivalent to Zod's `safeParse()` shape.
 */
export function safeParseValue<T extends TSchema>(
  schema: T,
  value: unknown,
): SchemaResult<T> {
  return compiledSafeParseValue(schema, value)
}

/**
 * Filter an array of `unknown` values, keeping only those that match the
 * given schema. Mirrors the previous Zod pattern:
 *
 *     z.array(z.unknown()).transform((items) =>
 *       items.flatMap((item) => {
 *         const r = ItemSchema.safeParse(item)
 *         return r.success ? [r.data] : []
 *       }),
 *     )
 *
 * Used for tolerant parsing of stored arrays (font files, page-tree items)
 * where one bad entry should not invalidate the whole site document.
 */
export function filterArray<T extends TSchema>(
  itemSchema: T,
  values: unknown,
): TBStatic<T>[] {
  if (!Array.isArray(values)) return []
  const validator = compiled(itemSchema)
  const out: TBStatic<T>[] = []
  for (const item of values) {
    if (validator.Check(item)) {
      out.push(validator.Decode(item) as TBStatic<T>)
    }
  }
  return out
}

/**
 * Format compiled TypeBox errors into a single human-readable message. Used by
 * `parseValue` and at HTTP boundaries to produce useful error responses.
 */
export function formatValueErrors(schema: TSchema, value: unknown): string {
  return compiledFormatValueErrors(schema, value)
}
