/**
 * The content hash every branch base and merge plan compares, and the wire
 * parse merged content goes through before it is written back. What the
 * content of each kind IS lives with its adapter in `./entities/`.
 */
import { createHash } from 'node:crypto'
import type { Static, TSchema } from '@sinclair/typebox'
import { safeParseValue } from '@core/utils/typeboxHelpers'
import { canonicalJson } from '@core/utils/canonicalJson'

export function contentHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

/** Parse merged content back into its typed shape; throws on drift. */
export function parseContent<T extends TSchema>(schema: T, value: unknown, what: string): Static<T> {
  const parsed = safeParseValue(schema, value)
  if (!parsed.ok) {
    const detail = parsed.errors.map((issue) => `${issue.path}: ${issue.message}`).join('; ')
    throw new Error(`[branches] merged ${what} content is malformed: ${detail}`)
  }
  return parsed.value
}
