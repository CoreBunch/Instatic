import { describe, expect, it } from 'bun:test'
import {
  SUPPORTED_LOCALES,
  expandNames,
  parseTranslations,
  resolveName,
} from './locales'

const bruxelles = parseTranslations([
  { languages_code: 'fr-BE', name: 'Bruxelles' },
  { languages_code: 'nl-BE', name: 'Brussel' },
  { languages_code: 'de-BE', name: 'Brüssel' },
  { languages_code: 'en-BE', name: 'Brussels' },
])

const paris = parseTranslations([
  { languages_code: 'fr-FR', name: 'Paris' },
])

describe('Directus locale fallback', () => {
  it('uses the same language in another region before the country default', () => {
    expect(resolveName(bruxelles, 'nl-NL', 'BE')).toBe('Brussel')
    expect(resolveName(bruxelles, 'en-FR', 'BE')).toBe('Brussels')
  })

  it('resolves Paris in fr-BE instead of returning null', () => {
    expect(resolveName(paris, 'fr-BE', 'FR')).toBe('Paris')
    expect(resolveName(paris, 'nl-BE', 'FR')).toBe('Paris')
  })

  it('expands names to all 8 locales', () => {
    const names = expandNames(bruxelles, 'BE')
    expect(Object.keys(names).sort()).toEqual([...SUPPORTED_LOCALES].sort())
    expect(names['fr-BE']).toBe('Bruxelles')
    expect(names['nl-BE']).toBe('Brussel')
    expect(names['nl-NL']).toBe('Brussel')
    expect(names['fr-FR']).toBe('Bruxelles')
    expect(names['en-NL']).toBe('Brussels')
  })

  it('fills every Paris locale with the one real name', () => {
    const names = expandNames(paris, 'FR')
    for (const locale of SUPPORTED_LOCALES) {
      expect(names[locale]).toBe('Paris')
    }
  })

  it('reads a languages_code object', () => {
    const rows = parseTranslations([{ languages_code: { code: 'fr-BE' }, name: 'Liège' }])
    expect(resolveName(rows, 'fr-BE', 'BE')).toBe('Liège')
  })
})
