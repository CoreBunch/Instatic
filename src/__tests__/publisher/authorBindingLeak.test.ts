/**
 * A binding must never publish internal shape.
 *
 * `{currentEntry.author}` used to resolve to the `PublicDataUserReference`
 * object, and the token interpolator JSON-stringified any non-scalar "so
 * mistakes stay visible" — an author-facing debug affordance running in the
 * public publish path. A single template binding therefore published
 * `{"displayName":"owner@example.com","roleSlug":"owner","roleName":"Owner"}`
 * into live HTML, and into every screenshot taken of it.
 *
 * Two independent guards keep that shut, and both are asserted here: the
 * people keys are leaf strings, and a non-scalar value renders as nothing
 * rather than as JSON.
 */
import { describe, expect, it } from 'bun:test'
import { interpolateTokens } from '@core/templates/tokenInterpolation'
import type { TemplateContext } from '@core/templates/contextFrames'

function contextWithEntry(fields: Record<string, unknown>): TemplateContext {
  return { entryStack: [{ id: 'row_1', fields }] } as unknown as TemplateContext
}

describe('author bindings never publish internal shape', () => {
  it('renders the display name for {currentEntry.author}', () => {
    const ctx = contextWithEntry({ author: 'Rosa Ferrandis' })
    expect(interpolateTokens('By {currentEntry.author}', ctx)).toBe('By Rosa Ferrandis')
  })

  it('renders nothing for a binding that resolves to an object', () => {
    const ctx = contextWithEntry({
      author: { displayName: 'owner@example.com', roleSlug: 'owner', roleName: 'Owner' },
    })
    const out = interpolateTokens('By {currentEntry.author}', ctx)

    expect(out).toBe('By ')
    expect(out).not.toContain('@')
    expect(out).not.toContain('roleSlug')
    expect(out).not.toContain('displayName')
  })

  it('renders nothing for a binding that resolves to an array', () => {
    const ctx = contextWithEntry({ tags: ['a', 'b'] })
    expect(interpolateTokens('{currentEntry.tags}', ctx)).toBe('')
  })

  it('still honours an author-supplied fallback when the value is non-scalar', () => {
    const ctx = contextWithEntry({ author: { displayName: 'owner@example.com' } })
    expect(interpolateTokens('{currentEntry.author|Anonymous}', ctx)).toBe('Anonymous')
  })

  it('leaves scalar bindings untouched', () => {
    const ctx = contextWithEntry({ title: 'El inventario', year: 2025, pardoned: false })
    expect(interpolateTokens('{currentEntry.title} ({currentEntry.year})', ctx))
      .toBe('El inventario (2025)')
    expect(interpolateTokens('{currentEntry.pardoned}', ctx)).toBe('false')
  })
})
