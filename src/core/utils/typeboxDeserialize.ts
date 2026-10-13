import { TypeGuard, type TSchema } from '@sinclair/typebox'
import { Type } from './typeboxHelpers'
import { compiledCheck } from './typeboxCompiler'

const SchemaJson = Type.Recursive(Self => Type.Union([
  Type.Null(), Type.Boolean(), Type.Number(), Type.String(),
  Type.Array(Self), Type.Record(Type.String(), Self),
]))
const SchemaWire = Type.Object({
  schema: SchemaJson,
  annotations: Type.Array(Type.Object({
    path: Type.Array(Type.String()),
    symbols: Type.Partial(Type.Object({ Kind: Type.String(), Optional: Type.String(), Readonly: Type.String(), Hint: Type.String() }, { additionalProperties: false })),
  }, { additionalProperties: false })),
}, { additionalProperties: false })

/** A hard, validated boundary; executable transforms are never transported. */
export function deserializeTypeBoxSchema(wire: string | undefined): TSchema | undefined {
  if (wire === undefined) return undefined
  const raw: unknown = JSON.parse(wire)
  if (!compiledCheck(SchemaWire, raw)) throw new Error('Invalid serialized module schema')
  for (const annotation of raw.annotations) {
    let current: unknown = raw.schema
    for (const key of annotation.path) {
      if (!current || typeof current !== 'object' || !Object.hasOwn(current, key)) throw new Error('Invalid module schema annotation path')
      current = Reflect.get(current, key)
    }
    if (!current || typeof current !== 'object' || Array.isArray(current)) throw new Error('Invalid module schema annotation target')
    for (const [name, value] of Object.entries(annotation.symbols)) {
      Object.defineProperty(current, Symbol.for('TypeBox.' + name), { value, configurable: true, enumerable: true })
    }
  }
  const schema = raw.schema
  if (!TypeGuard.IsSchema(schema)) throw new Error('Invalid declarative TypeBox module schema')
  return schema
}
