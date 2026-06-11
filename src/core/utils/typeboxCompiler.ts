import type { TSchema, Static as TBStatic } from '@sinclair/typebox'
import { TypeCompiler, type TypeCheck } from '@sinclair/typebox/compiler'

const compiledCache = new WeakMap<TSchema, TypeCheck<TSchema>>()

type CompiledType<T extends TSchema> = TypeCheck<T>

type CompiledSchemaResult<T extends TSchema> =
  | { ok: true; value: TBStatic<T> }
  | { ok: false; errors: ReadonlyArray<{ path: string; message: string }> }

/**
 * Compile a TypeBox schema once and reuse the generated validator. TypeBox
 * does not cache compiled validators internally, so this module owns the app
 * lifetime cache for hot `Check` / `Decode` / `Errors` paths.
 */
export function compiled<T extends TSchema>(schema: T): CompiledType<T> {
  const existing = compiledCache.get(schema)
  if (existing) return existing as CompiledType<T>

  const next = TypeCompiler.Compile(schema)
  compiledCache.set(schema, next as TypeCheck<TSchema>)
  return next
}

export function compiledCheck<T extends TSchema>(schema: T, value: unknown): value is TBStatic<T> {
  return compiled(schema).Check(value)
}

export function compiledDecode<T extends TSchema>(schema: T, value: unknown): TBStatic<T> {
  return compiled(schema).Decode(value) as TBStatic<T>
}

export function compiledSafeParseValue<T extends TSchema>(
  schema: T,
  value: unknown,
): CompiledSchemaResult<T> {
  const validator = compiled(schema)
  if (!validator.Check(value)) {
    const errors: { path: string; message: string }[] = []
    for (const err of validator.Errors(value)) {
      errors.push({ path: err.path, message: err.message })
    }
    return { ok: false, errors }
  }
  return { ok: true, value: validator.Decode(value) as TBStatic<T> }
}

export function compiledFormatValueErrors(schema: TSchema, value: unknown): string {
  const issues: string[] = []
  for (const err of compiled(schema).Errors(value)) {
    issues.push(`${err.path || '<root>'}: ${err.message}`)
    if (issues.length >= 5) break
  }
  return issues.join('; ') || 'Validation failed'
}
