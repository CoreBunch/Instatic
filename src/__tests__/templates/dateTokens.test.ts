import { describe, expect, it } from 'bun:test'
import { interpolateTokens } from '@core/templates/tokenInterpolation'
import type { TemplateRenderDataContext } from '@core/templates/renderDataContext'

function context(value: unknown): TemplateRenderDataContext {
  return { entryStack: [{ id: 'event', fields: { datum: value } }] }
}

describe('date tokens', () => {
  it('formats a calendar date with its correct German weekday', () => {
    expect(interpolateTokens('{currentEntry.datum:date(de-DE,full)}', context('2026-09-18')))
      .toBe('Freitag, 18. September 2026')
  })

  it('keeps the original sortable value and supports other locales', () => {
    expect(interpolateTokens('{currentEntry.datum} / {currentEntry.datum:date(en-US,long)}', context('2026-09-18')))
      .toBe('2026-09-18 / September 18, 2026')
  })

  it.each([undefined, null, '', '2026-02-30', 'not a date', '2026-09-18T12:00:00Z', {}])(
    'uses the normal fallback for missing or invalid calendar dates: %p', (value) => {
      expect(interpolateTokens('{currentEntry.datum:date(de-DE,full)|Termin folgt}', context(value)))
        .toBe('Termin folgt')
    },
  )

  it('handles leap dates without local timezone shifts', () => {
    expect(interpolateTokens('{currentEntry.datum:date(de-DE,long)}', context('2028-02-29')))
      .toBe('29. Februar 2028')
  })
})
