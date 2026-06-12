import { describe, expect, it } from 'bun:test'
import { parsePageTemplate } from '../pageTemplate'

describe('parsePageTemplate target', () => {
  it('parses an everywhere target', () => {
    const t = parsePageTemplate({ enabled: true, target: { kind: 'everywhere' }, priority: 5 })
    expect(t).toEqual({ enabled: true, target: { kind: 'everywhere' }, priority: 5 })
  })

  it('parses a postTypes target and drops blank slugs', () => {
    const t = parsePageTemplate({ enabled: true, target: { kind: 'postTypes', tableSlugs: ['posts', ''] }, priority: 0 })
    expect(t).toEqual({ enabled: true, target: { kind: 'postTypes', tableSlugs: ['posts'] }, priority: 0 })
  })

  it('parses a notFound target', () => {
    const t = parsePageTemplate({ enabled: true, target: { kind: 'notFound' }, priority: 0 })
    expect(t).toEqual({ enabled: true, target: { kind: 'notFound' }, priority: 0 })
  })

  it('rejects a postTypes target with no usable slugs', () => {
    expect(parsePageTemplate({ enabled: true, target: { kind: 'postTypes', tableSlugs: [''] }, priority: 0 })).toBeNull()
  })

  it('rejects the retired context/tableSlug shape', () => {
    expect(parsePageTemplate({ enabled: true, context: 'entry', tableSlug: 'posts', priority: 0 })).toBeNull()
  })

  it('ignores a stray conditions field (cut from the model)', () => {
    const t = parsePageTemplate({ enabled: true, target: { kind: 'everywhere' }, priority: 0, conditions: [{ id: 'x' }] })
    expect(t).toEqual({ enabled: true, target: { kind: 'everywhere' }, priority: 0 })
  })

  it('defaults priority', () => {
    const t = parsePageTemplate({ enabled: true, target: { kind: 'everywhere' } })
    expect(t).toEqual({ enabled: true, target: { kind: 'everywhere' }, priority: 0 })
  })
})
