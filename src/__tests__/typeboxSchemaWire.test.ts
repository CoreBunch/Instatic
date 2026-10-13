import { describe, expect, it } from 'bun:test'
import { Type, Value } from '@core/utils/typeboxHelpers'
import { compiledCheck } from '@core/utils/typeboxCompiler'
import { serializeTypeBoxSchema } from '@core/utils/typeboxSerialize'
import { deserializeTypeBoxSchema } from '@core/utils/typeboxDeserialize'

describe('declarative module schema transport', () => {
  it('preserves compiled validation, optional defaults and unions across JSON', () => {
    const source = Type.Object({
      count: Type.Integer({ minimum: 0, default: 1 }),
      mode: Type.Union([Type.Literal('on'), Type.Literal('off')]),
      label: Type.Optional(Type.String({ default: 'Label' })),
    })
    const decoded = deserializeTypeBoxSchema(serializeTypeBoxSchema(source))!
    expect(compiledCheck(decoded, { count: 2, mode: 'on' })).toBe(true)
    expect(compiledCheck(decoded, { count: -1, mode: 'other' })).toBe(false)
    expect(Value.Parse(decoded, { mode: 'off' })).toEqual({ count: 1, mode: 'off', label: 'Label' })
  })
  it('rejects executable transforms and malformed wire metadata', () => {
    expect(() => serializeTypeBoxSchema(Type.Transform(Type.String()).Decode(value => value.length).Encode(value => String(value)))).toThrow('declarative')
    expect(() => deserializeTypeBoxSchema('{"schema":{},"annotations":[{"path":[],"symbols":{"Transform":"x"}}]}')).toThrow('serialized module schema')
    expect(() => deserializeTypeBoxSchema('{"schema":{"type":"string"},"annotations":[]}')).toThrow('declarative TypeBox')
    expect(deserializeTypeBoxSchema(undefined)).toBeUndefined()
  })
  it('keeps arbitrary authored default keys separate from transport annotations', () => {
    const source = Type.Unknown({ default: { __instaticTypeBox: { user: 'content' }, annotations: [] } })
    const decoded = deserializeTypeBoxSchema(serializeTypeBoxSchema(source))!
    expect(Value.Parse(decoded, undefined)).toEqual(source.default)
  })
})
