/**
 * JSON validation helpers backed by TypeBox.
 *
 * The codebase has many `JSON.parse(raw) as Foo` and `await res.json() as Foo`
 * call sites. The cast is the model lying — the runtime trusts whatever shape
 * happens to come back. Use these helpers at the boundary instead.
 */

import type { TSchema, Static } from '@sinclair/typebox'
import {
  compiledCheck,
  compiledDecode,
  compiledFormatValueErrors,
} from './typeboxCompiler'

type JsonParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: Error }

/**
 * Parse a string as JSON and validate it against a TypeBox schema.
 *
 * Returns a discriminated union so callers can decide between a hard error and
 * a soft fallback (e.g. for localStorage reads where corrupted data should not
 * brick the editor — fall back to defaults).
 */
export function safeParseJson<T extends TSchema>(
  raw: string,
  schema: T,
): JsonParseResult<Static<T>> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Treat invalid JSON the same as a failed schema validation. Callers don't
    // need to distinguish "wasn't JSON" from "was JSON but wrong shape" — both
    // mean "discard and use defaults" or "return 400".
    return { ok: false, error: new Error('Invalid JSON') }
  }
  if (!compiledCheck(schema, parsed)) {
    return { ok: false, error: new Error(compiledFormatValueErrors(schema, parsed)) }
  }
  return { ok: true, value: compiledDecode(schema, parsed) as Static<T> }
}

/**
 * Convenience: parse a string as JSON and validate, falling back to a default
 * value on any failure. Use for best-effort reads (localStorage, optional
 * config files) where the caller has a reasonable default.
 */
export function parseJsonWithFallback<T extends TSchema>(
  raw: string | null | undefined,
  schema: T,
  fallback: Static<T>,
): Static<T> {
  if (raw == null || raw === '') return fallback
  const result = safeParseJson(raw, schema)
  return result.ok ? result.value : fallback
}

/**
 * Parse and validate a Response body. Returns the value or throws — meant for
 * places where a malformed response is genuinely an error condition (the
 * caller should let it bubble up to a top-level error boundary).
 */
export async function parseJsonResponse<T extends TSchema>(
  res: Response,
  schema: T,
): Promise<Static<T>> {
  const data = (await res.json()) as unknown
  if (!compiledCheck(schema, data)) {
    throw new Error(compiledFormatValueErrors(schema, data))
  }
  return compiledDecode(schema, data) as Static<T>
}
