import { describe, expect, it } from 'bun:test'
import { createDirectusClient } from './client'
import { flattenGeographyRow, getGeographyAncestry, listGeography } from './geography'

const BRUXELLES_ID = '03af8c53-1111-4111-8111-000000000001'
const PROVINCE_ID = 'd27566cb-1111-4111-8111-000000000002'
const REGION_ID = 'aaaaaaaa-1111-4111-8111-000000000003'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
}

describe('geography flattening', () => {
  it('does not leak translation arrays', () => {
    const row = flattenGeographyRow('municipalities', {
      id: BRUXELLES_ID,
      slug: 'bruxelles',
      country: 'BE',
      official_code: '21004',
      population: 196828,
      postal_codes: ['1000', '1020'],
      latitude: 50.855,
      longitude: 4.3512,
      is_major: true,
      province: PROVINCE_ID,
      translations: [
        { languages_code: 'fr-BE', name: 'Bruxelles' },
        { languages_code: 'nl-BE', name: 'Brussel' },
      ],
    }, { locale: 'fr-BE' })
    expect(row).toMatchObject({
      type: 'municipalities',
      slug: 'bruxelles',
      name: 'Bruxelles',
      country: 'BE',
      officialCode: '21004',
      population: 196828,
      postalCodes: ['1000', '1020'],
      isMajor: true,
      provinceId: PROVINCE_ID,
    })
    expect(row).not.toHaveProperty('translations')
  })

  it('keys countries by code: no id, no slug column upstream', () => {
    // Real DEV row shape: `countries` has `code` as its primary key and no
    // `id`/`slug`. The old flattener required `id` and silently dropped every
    // country, so `countries` listed as `{ data: [], count: 2 }`.
    const row = flattenGeographyRow('countries', {
      code: 'BE',
      default_language: 'fr-BE',
      population: 11763650,
      flag_image: null,
      translations: [
        { languages_code: 'fr-BE', name: 'Belgique' },
        { languages_code: 'nl-BE', name: 'België' },
      ],
    }, { locale: 'nl-BE' })
    expect(row).toMatchObject({ type: 'countries', id: 'BE', slug: 'BE', country: 'BE', name: 'België', population: 11763650 })
    expect(flattenGeographyRow('countries', { id: 'not-a-country-shape' }, {})).toBeNull()
  })
})

describe('geography list + ancestry', () => {
  it('filters countries on code, never on slug (which is a Directus 403)', async () => {
    const urls: string[] = []
    const client = createDirectusClient({
      config: { url: 'https://cms.example.com', token: 't' },
      fetch: async (input) => {
        urls.push(input)
        return jsonResponse({ data: [{ code: 'BE', translations: [] }], meta: { filter_count: 1 } })
      },
    })
    await listGeography(client, 'countries', { slug: 'BE', limit: 10, page: 1 })
    await listGeography(client, 'municipalities', { slug: 'bruxelles', limit: 10, page: 1 })
    const countriesFilter = new URL(urls[0]).searchParams.get('filter')
    const municipalitiesFilter = new URL(urls[1]).searchParams.get('filter')
    expect(JSON.parse(countriesFilter ?? '{}')).toEqual({ code: { _eq: 'BE' } })
    expect(countriesFilter).not.toContain('slug')
    expect(JSON.parse(municipalitiesFilter ?? '{}')).toEqual({ slug: { _eq: 'bruxelles' } })
  })

  it('uses filter_count, not total_count', async () => {
    const client = createDirectusClient({
      config: { url: 'https://cms.example.com', token: 't' },
      fetch: async () => jsonResponse({
        data: [{ id: BRUXELLES_ID, slug: 'bruxelles', country: 'BE', translations: [] }],
        meta: { filter_count: 12, total_count: 35311 },
      }),
    })
    const listed = await listGeography(client, 'municipalities', { country: 'BE', limit: 1, page: 1 })
    expect(listed.count).toBe(12)
    expect(listed.pageSize).toBe(1)
  })

  it('climbs municipality → province → region → country', async () => {
    const client = createDirectusClient({
      config: { url: 'https://cms.example.com', token: 't' },
      fetch: async (input) => {
        if (input.includes('/items/municipalities')) {
          return jsonResponse({
            data: [{
              id: BRUXELLES_ID,
              slug: 'bruxelles',
              country: 'BE',
              province: PROVINCE_ID,
              translations: [{ languages_code: 'fr-BE', name: 'Bruxelles' }],
            }],
            meta: { filter_count: 1 },
          })
        }
        if (input.includes('/items/provinces')) {
          return jsonResponse({
            data: [{
              id: PROVINCE_ID,
              slug: 'bruxelles-capitale',
              country: 'BE',
              region: REGION_ID,
              translations: [{ languages_code: 'fr-BE', name: 'Bruxelles-Capitale' }],
            }],
          })
        }
        if (input.includes('/items/regions')) {
          return jsonResponse({
            data: [{
              id: REGION_ID,
              slug: 'bruxelles-capitale',
              country: 'BE',
              translations: [{ languages_code: 'fr-BE', name: 'Région de Bruxelles-Capitale' }],
            }],
          })
        }
        return jsonResponse({
          data: [{
            code: 'BE',
            translations: [{ languages_code: 'fr-BE', name: 'Belgique' }],
          }],
        })
      },
    })
    const ancestry = await getGeographyAncestry(client, { slug: 'bruxelles', locale: 'fr-BE' })
    expect(ancestry.municipality.name).toBe('Bruxelles')
    expect(ancestry.province?.name).toBe('Bruxelles-Capitale')
    expect(ancestry.region?.name).toBe('Région de Bruxelles-Capitale')
    expect(ancestry.country?.name).toBe('Belgique')
    expect(ancestry.country?.id).toBe('BE')
  })
})
