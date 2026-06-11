/**
 * Unit tests for validateNodeProps — the soft publisher-boundary coercion helper.
 *
 * Covers:
 *   (a) Junk / missing authored props coerce to module defaults via the schema.
 *   (b) Unknown injected fields (e.g. _resolvedMediaByKey) survive validation.
 *   (c) A module with no propsSchema returns rawProps unchanged (pass-through).
 *   (d) Fast path: already-conforming props return the SAME object reference
 *       (no clone) when the schema is fast-path eligible.
 *   (e) Eligibility guards: optional-with-default and Transform schemas must
 *       NOT take the fast path (Value.Parse output is not value-identical to
 *       rawProps for them); Ref/recursive/cyclic schemas degrade safely to
 *       the slow path.
 *   (f) Every base module's propsSchema is fast-path eligible.
 */

import { describe, it, expect } from 'bun:test'
import { Type, Value, type TSchema } from '@core/utils/typeboxHelpers'
import type { AnyModuleDefinition } from '@core/module-engine'
import { validateNodeProps, registry } from '@core/module-engine'
import { SquareSolidIcon } from 'pixel-art-icons/icons/square-solid'

// Side-effect import: registers every base module into the global registry
// singleton so suite (f) can iterate their real propsSchemas.
import '@modules/base'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stubDef(
  overrides: Partial<AnyModuleDefinition> = {},
): AnyModuleDefinition {
  return {
    id: 'test.stub',
    name: 'Stub',
    category: 'Test',
    version: '1.0.0',
    icon: SquareSolidIcon,
    trusted: true,
    canHaveChildren: false,
    schema: {},
    defaults: {},
    component: (() => null) as never,
    render: () => ({ html: '' }),
    ...overrides,
  }
}

// A minimal schema with per-field defaults for testing coercion.
const TestPropsSchema = Type.Object({
  text: Type.String({ default: 'Hello' }),
  count: Type.Number({ default: 42 }),
  visible: Type.Boolean({ default: true }),
})

const testDefaults = Value.Create(TestPropsSchema) as Record<string, unknown>

// ---------------------------------------------------------------------------
// (a) Missing / junk props coerce to schema defaults
// ---------------------------------------------------------------------------

describe('validateNodeProps — (a) coerce to schema defaults', () => {
  const def = stubDef({
    propsSchema: TestPropsSchema,
    defaults: testDefaults,
  })

  it('fills in missing props with schema defaults (empty rawProps)', () => {
    const result = validateNodeProps(def, {})
    expect(result.text).toBe('Hello')
    expect(result.count).toBe(42)
    expect(result.visible).toBe(true)
  })

  it('coerces a string number to a number when the schema declares number', () => {
    // Value.Convert turns "7" → 7 for a Type.Number field.
    const result = validateNodeProps(def, { count: '7' })
    expect(result.count).toBe(7)
  })

  it('preserves a correctly typed authored value (no coercion needed)', () => {
    const result = validateNodeProps(def, { text: 'World', count: 99, visible: false })
    expect(result.text).toBe('World')
    expect(result.count).toBe(99)
    expect(result.visible).toBe(false)
  })

  it('falls back to module defaults when coercion fails catastrophically', () => {
    // Provide a deeply invalid value that Value.Parse cannot recover.
    // We force a failure by using a schema whose type can't be coerced.
    const strictSchema = Type.Object({
      id: Type.String({ pattern: '^[a-z]+$', default: 'fallback' }),
    })
    const strictDef = stubDef({
      propsSchema: strictSchema,
      defaults: { id: 'fallback' },
    })
    // "123" fails the /^[a-z]+$/ pattern — coercion cannot fix it.
    const result = validateNodeProps(strictDef, { id: '123' })
    // Should fall back to defaults
    expect(result.id).toBe('fallback')
  })
})

// ---------------------------------------------------------------------------
// (b) Unknown injected fields survive validation
// ---------------------------------------------------------------------------

describe('validateNodeProps — (b) injected unknown fields survive', () => {
  const def = stubDef({
    propsSchema: TestPropsSchema,
    defaults: testDefaults,
  })

  it('preserves _resolvedMediaByKey on rawProps', () => {
    const injected = { propKey: { url: 'https://cdn.example.com/img.jpg' } }
    const result = validateNodeProps(def, { _resolvedMediaByKey: injected })
    expect(result._resolvedMediaByKey).toBe(injected)
  })

  it('preserves _resolvedAutoSizes on rawProps', () => {
    const result = validateNodeProps(def, { _resolvedAutoSizes: '(max-width: 800px) 100vw' })
    expect(result._resolvedAutoSizes).toBe('(max-width: 800px) 100vw')
  })

  it('preserves multiple unknown injected fields simultaneously', () => {
    const mediaByKey = { img: { url: 'https://example.com/a.jpg' } }
    const rawProps = {
      text: 'Hi',
      _resolvedMediaByKey: mediaByKey,
      _resolvedAutoSizes: '100vw',
      _customInjected: 'stays',
    }
    const result = validateNodeProps(def, rawProps)
    expect(result._resolvedMediaByKey).toBe(mediaByKey)
    expect(result._resolvedAutoSizes).toBe('100vw')
    expect(result._customInjected).toBe('stays')
    expect(result.text).toBe('Hi')
  })

  it('coerced schema props override rawProps while unknowns are preserved', () => {
    const rawProps = {
      count: '5',                  // will be coerced to 5
      _unknownField: 'preserved',  // must survive
    }
    const result = validateNodeProps(def, rawProps)
    expect(result.count).toBe(5)
    expect(result._unknownField).toBe('preserved')
  })
})

// ---------------------------------------------------------------------------
// (c) Module with no propsSchema — pass-through
// ---------------------------------------------------------------------------

describe('validateNodeProps — (c) no propsSchema is a pass-through', () => {
  it('returns rawProps reference-identical when propsSchema is absent', () => {
    const def = stubDef() // no propsSchema
    const rawProps = { text: 'hello', count: 1, _injected: true }
    const result = validateNodeProps(def, rawProps)
    // Should be the exact same object — no copy
    expect(result).toBe(rawProps)
  })

  it('returns rawProps unchanged even when they would fail a hypothetical schema', () => {
    const def = stubDef({ defaults: { text: 'default' } })
    const rawProps = { text: 123, garbage: true }
    const result = validateNodeProps(def, rawProps)
    expect(result).toStrictEqual({ text: 123, garbage: true })
  })
})

// ---------------------------------------------------------------------------
// (d) Fast path — conforming props return the SAME object reference
// ---------------------------------------------------------------------------

describe('validateNodeProps — (d) fast path for already-conforming props', () => {
  const def = stubDef({
    propsSchema: TestPropsSchema,
    defaults: testDefaults,
  })

  it('returns the exact same object when props already conform', () => {
    const rawProps = { text: 'World', count: 99, visible: false }
    const result = validateNodeProps(def, rawProps)
    expect(result).toBe(rawProps)
  })

  it('returns the same object when conforming props carry unknown injected keys', () => {
    const injected = { img: { url: 'https://example.com/a.jpg' } }
    const rawProps = {
      text: 'Hi',
      count: 1,
      visible: true,
      _resolvedMediaByKey: injected,
      _resolvedAutoSizes: '100vw',
    }
    const result = validateNodeProps(def, rawProps)
    expect(result).toBe(rawProps)
    expect(result._resolvedMediaByKey).toBe(injected)
  })

  it('takes the slow path when a required-with-default prop is absent (default materialized)', () => {
    const rawProps = { count: 1, visible: true } // text missing
    const result = validateNodeProps(def, rawProps)
    expect(result).not.toBe(rawProps)
    expect(result.text).toBe('Hello')
    expect(result.count).toBe(1)
  })

  it('takes the slow path when a prop needs coercion (string → number)', () => {
    const rawProps = { text: 'a', count: '7', visible: true }
    const result = validateNodeProps(def, rawProps)
    expect(result).not.toBe(rawProps)
    expect(result.count).toBe(7)
  })

  it('handles nested eligible composites (array / union / record / tuple / literal)', () => {
    const NestedSchema = Type.Object({
      tags: Type.Array(Type.String(), { default: [] }),
      align: Type.Union([Type.Literal('left'), Type.Literal('right')], { default: 'left' }),
      attrs: Type.Record(Type.String(), Type.String(), { default: {} }),
      pair: Type.Tuple([Type.Number(), Type.Number()]),
      nothing: Type.Null(),
    })
    const nestedDef = stubDef({ propsSchema: NestedSchema, defaults: {} })
    const rawProps = {
      tags: ['a', 'b'],
      align: 'right',
      attrs: { role: 'note' },
      pair: [1, 2],
      nothing: null,
    }
    expect(validateNodeProps(nestedDef, rawProps)).toBe(rawProps)
  })
})

// ---------------------------------------------------------------------------
// (e) Eligibility guards — schemas where Check-pass ≠ Parse-identity
// ---------------------------------------------------------------------------

describe('validateNodeProps — (e) fast-path eligibility guards', () => {
  it('optional-with-default: absent key passes Check but the default MUST be materialized', () => {
    // `{}` passes compiled Check (x is optional) — a naive fast path would
    // return rawProps and silently lose the default. The eligibility guard
    // must route this schema to Value.Parse.
    const OptDefaultSchema = Type.Object({
      x: Type.Optional(Type.String({ default: 'materialized' })),
    })
    const def = stubDef({ propsSchema: OptDefaultSchema, defaults: {} })
    const rawProps = {}
    const result = validateNodeProps(def, rawProps)
    expect(result.x).toBe('materialized')
    expect(result).not.toBe(rawProps)
  })

  it('optional-with-default: ineligibility is per-schema, even when the value is present', () => {
    const OptDefaultSchema = Type.Object({
      x: Type.Optional(Type.String({ default: 'd' })),
    })
    const def = stubDef({ propsSchema: OptDefaultSchema, defaults: {} })
    const rawProps = { x: 'present' }
    const result = validateNodeProps(def, rawProps)
    // Slow path always clones — same value, new object.
    expect(result).not.toBe(rawProps)
    expect(result.x).toBe('present')
  })

  it('optional-with-default nested deeper in the tree is also caught', () => {
    const NestedOptDefault = Type.Object({
      inner: Type.Object({
        y: Type.Optional(Type.Number({ default: 5 })),
      }),
    })
    const def = stubDef({ propsSchema: NestedOptDefault, defaults: {} })
    const rawProps = { inner: {} }
    const result = validateNodeProps(def, rawProps)
    expect((result.inner as Record<string, unknown>).y).toBe(5)
  })

  it('optional WITHOUT default stays eligible (nothing to materialize)', () => {
    const OptNoDefault = Type.Object({
      x: Type.Optional(Type.String()),
      n: Type.Number(),
    })
    const def = stubDef({ propsSchema: OptNoDefault, defaults: {} })
    const absent = { n: 1 }
    expect(validateNodeProps(def, absent)).toBe(absent)
    const present = { n: 1, x: 'v' }
    expect(validateNodeProps(def, present)).toBe(present)
  })

  it('Unknown without default stays eligible (used by base.loop / base.visual-component-ref)', () => {
    const UnknownRecord = Type.Object({
      rec: Type.Record(Type.String(), Type.Unknown(), { default: {} }),
    })
    const def = stubDef({ propsSchema: UnknownRecord, defaults: {} })
    const rawProps = { rec: { a: { nested: [1, 2] }, b: 'str' } }
    expect(validateNodeProps(def, rawProps)).toBe(rawProps)
  })

  it('Unknown WITH default is ineligible (present-undefined would be replaced by Parse)', () => {
    const HazardSchema = Type.Object({
      rec: Type.Record(Type.String(), Type.Unknown({ default: 'D' })),
    })
    const def = stubDef({ propsSchema: HazardSchema, defaults: {} })
    // `{ k: undefined }` passes Check against Unknown — but Value.Parse
    // materializes the default. The fast path must not swallow that.
    const result = validateNodeProps(def, { rec: { k: undefined } })
    expect((result.rec as Record<string, unknown>).k).toBe('D')
  })

  it('Transform schema: Decode MUST run even when the encoded value passes Check', () => {
    const UpperTransform = Type.Transform(Type.String())
      .Decode((s) => s.toUpperCase())
      .Encode((s) => s.toLowerCase())
    const def = stubDef({
      propsSchema: Type.Object({ name: UpperTransform }),
      defaults: {},
    })
    // 'abc' passes Check against the inner String — a naive fast path would
    // skip the Decode and return 'abc'.
    const result = validateNodeProps(def, { name: 'abc' })
    expect(result.name).toBe('ABC')
  })

  it('Transform nested inside an array is also caught', () => {
    const UpperTransform = Type.Transform(Type.String())
      .Decode((s) => s.toUpperCase())
      .Encode((s) => s.toLowerCase())
    const def = stubDef({
      propsSchema: Type.Object({ tags: Type.Array(UpperTransform) }),
      defaults: {},
    })
    const result = validateNodeProps(def, { tags: ['abc', 'def'] })
    expect(result.tags).toEqual(['ABC', 'DEF'])
  })

  it('recursive (This/Ref) schemas degrade to the slow path without crashing', () => {
    const RecursiveSchema = Type.Recursive((Self) =>
      Type.Object({
        name: Type.String(),
        kids: Type.Array(Self),
      }),
    )
    const def = stubDef({ propsSchema: RecursiveSchema, defaults: {} })
    const rawProps = { name: 'root', kids: [{ name: 'child', kids: [] }] }
    const result = validateNodeProps(def, rawProps)
    expect(result).not.toBe(rawProps) // conservative: slow path
    expect(result.name).toBe('root')
    expect(result.kids).toEqual([{ name: 'child', kids: [] }])
  })

  it('a literally cyclic schema object terminates the eligibility walk (slow path)', () => {
    // Hand-built degenerate input: the schema object references itself. The
    // eligibility walk must terminate (cycle guard) and report ineligible —
    // compiling such a schema would never finish.
    const cyclic = Type.Object({ name: Type.String() })
    ;(cyclic.properties as Record<string, TSchema>).self = Type.Optional(cyclic)
    const def = stubDef({ propsSchema: cyclic, defaults: {} })
    const rawProps = { name: 'x' }
    const result = validateNodeProps(def, rawProps)
    expect(result).not.toBe(rawProps) // slow path took over
    expect(result.name).toBe('x')
  })
})

// ---------------------------------------------------------------------------
// (f) Every base module's propsSchema is fast-path eligible
// ---------------------------------------------------------------------------

describe('validateNodeProps — (f) all base module schemas are fast-path eligible', () => {
  const baseDefs = registry
    .list()
    .filter((d) => d.id.startsWith('base.') && d.propsSchema !== undefined)

  it('registry contains base modules with propsSchemas', () => {
    expect(baseDefs.length).toBeGreaterThan(5)
  })

  for (const def of baseDefs) {
    it(`${def.id}: conforming props take the fast path (same reference back)`, () => {
      // First call normalizes the module defaults through whatever path they
      // need; the normalized output is by construction schema-conforming, so
      // the second call MUST short-circuit and return the same reference.
      const normalized = validateNodeProps(def, { ...def.defaults })
      expect(validateNodeProps(def, normalized)).toBe(normalized)
    })
  }
})
