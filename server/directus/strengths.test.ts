import { describe, expect, it } from 'bun:test'
import { isStrengthId, listStrengths, parseStrengthListQuery, STRENGTH_IDS } from './strengths'
import { SUPPORTED_LOCALES } from './locales'
import { isDirectusError } from './service'

describe('strengths catalog', () => {
  it('exposes the 20 intake ids', () => {
    expect(STRENGTH_IDS.length).toBe(20)
    expect(STRENGTH_IDS[0]).toBe('owner-on-site')
    expect(isStrengthId('after-sales')).toBe(true)
    expect(isStrengthId('nope')).toBe(false)
  })

  it('fills every supported locale and an icon', () => {
    for (const row of listStrengths().data) {
      expect(row.icon.length).toBeGreaterThan(0)
      for (const locale of SUPPORTED_LOCALES) {
        expect(row.names[locale].length).toBeGreaterThan(0)
      }
    }
  })

  it('uses the authored BE labels and falls back for other regions', () => {
    const [owner] = listStrengths({ ids: ['owner-on-site'] }).data
    expect(owner?.names['nl-BE']).toBe('Zaakvoerder op de werf')
    expect(owner?.names['fr-FR']).toBe('Le patron sur le chantier')
    expect(owner?.names['nl-NL']).toBe('Zaakvoerder op de werf')
  })

  it('resolves one locale into name', () => {
    const { data, count } = listStrengths({ locale: 'de-BE', ids: ['free-quote'] })
    expect(count).toBe(1)
    expect(data[0]?.name).toBe('Kostenloses Angebot')
  })

  it('rejects an unknown id', () => {
    try {
      listStrengths({ ids: ['owner-on-site', 'bogus'] })
      throw new Error('expected throw')
    } catch (err) {
      expect(isDirectusError(err)).toBe(true)
      expect((err as Error).message).toContain('bogus')
    }
  })

  it('parses the query string', () => {
    const q = parseStrengthListQuery(new URLSearchParams('locale=nl-BE&ids=free-quote,%20careful-work'))
    expect(q).toEqual({ locale: 'nl-BE', ids: ['free-quote', 'careful-work'] })
    expect(parseStrengthListQuery(new URLSearchParams())).toEqual({ locale: undefined, ids: undefined })
  })
})
