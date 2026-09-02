import { describe, expect, it } from 'bun:test'
import { createDirectusClient } from './client'
import { DirectusError } from './errors'
import {
  canonicalLocalizedSlug,
  flattenWorkfieldRow,
  getWorkfield,
  listWorkfieldFaq,
  listWorkfields,
} from './workfields'

const ARCHITECT_ID = '14fbde9b-7575-4dea-ae02-644b86f6dced'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
}

/** Real DEV row shape for `workfield_content` (trimmed). */
function architectRow() {
  return {
    id: ARCHITECT_ID,
    slug: 'architect',
    type: 'trade',
    is_deleted: false,
    is_shadow: false,
    professional_count: 47,
    average_rating: 479,
    thumbnail: '753e56e7-11d6-452b-81aa-a446977202d5',
    demand_banner: '32374472-3999-4330-aabb-aa1418b91adb',
    listing_banner: '6503ed6f-4b9c-4fbd-a396-2257a0406ce4',
    translations: [
      { languages_code: 'fr-BE', name: 'Architecte', localised_slugs: 'architecte', a_trade_singular: 'un architecte', thumbnail: null },
      { languages_code: 'nl-BE', name: 'Architect', localised_slugs: 'oud-architect,architect', a_trade_singular: 'een architect' },
    ],
  }
}

describe('workfield flattening', () => {
  it('reads the real column names: hundredths rating, localised_slugs history, thumbnail asset', () => {
    const row = flattenWorkfieldRow(architectRow(), { locale: 'nl-BE', assetBase: 'https://cms.example.com' })
    expect(row).toEqual({
      id: ARCHITECT_ID,
      slug: 'architect',
      type: 'trade',
      name: 'Architect',
      localizedSlug: 'architect',
      professionalCount: 47,
      averageRating: 4.79,
      thumbnailUrl: 'https://cms.example.com/assets/753e56e7-11d6-452b-81aa-a446977202d5',
    })
  })

  it('localised_slugs: the marketplace routes on the LAST entry of the history', () => {
    expect(canonicalLocalizedSlug('prevention-inondation,prevention-inondations')).toBe('prevention-inondations')
    expect(canonicalLocalizedSlug(' a , b ,')).toBe('b')
    expect(canonicalLocalizedSlug('')).toBeUndefined()
    expect(canonicalLocalizedSlug(null)).toBeUndefined()
  })

  it('all_locales expands names to all 8 keys and slugs only where a locale has one', () => {
    const row = flattenWorkfieldRow(architectRow(), { allLocales: true, assetBase: 'https://cms.example.com' })
    expect(Object.keys(row?.names ?? {})).toHaveLength(8)
    expect(row?.names?.['nl-NL']).toBe('Architect')
    expect(row?.localizedSlugs?.['fr-BE']).toBe('architecte')
    expect(row?.localizedSlugs?.['nl-BE']).toBe('architect')
    expect(row?.localizedSlugs?.['fr-FR']).toBe('architecte')
  })
})

describe('workfield reads', () => {
  it('lists from workfield_content with the content-service published filter, never a status column', async () => {
    const urls: string[] = []
    const client = createDirectusClient({
      config: { url: 'https://cms.example.com', token: 't' },
      fetch: async (input) => {
        urls.push(input)
        return jsonResponse({ data: [architectRow()], meta: { filter_count: 25 } })
      },
    })
    const listed = await listWorkfields(client, { type: 'trade', locale: 'fr-BE', limit: 5, page: 1 })
    expect(listed.count).toBe(25)
    expect(listed.data[0]?.name).toBe('Architecte')
    const url = new URL(urls[0])
    expect(url.pathname).toBe('/items/workfield_content')
    expect(JSON.parse(url.searchParams.get('filter') ?? '{}')).toEqual({
      is_deleted: { _eq: false },
      is_shadow: { _eq: false },
      type: { _eq: 'trade' },
    })
    expect(url.searchParams.get('filter')).not.toContain('status')
    expect(url.searchParams.get('sort')).toBe('slug')
  })

  it('detail: fetches includes from the flat per-locale collections, generic FAQ only', async () => {
    const urls: string[] = []
    const client = createDirectusClient({
      config: { url: 'https://cms.example.com', token: 't' },
      fetch: async (input) => {
        urls.push(input)
        const url = new URL(input)
        if (url.pathname === '/items/workfield_content') return jsonResponse({ data: [architectRow()] })
        if (url.pathname === '/items/workfield_pricing_items') {
          return jsonResponse({ data: [{ id: 'p1', sort: 1, status: 'published', label: 'Plans', price_indication: 'de 2500€ à 4000€' }] })
        }
        if (url.pathname === '/items/workfield_faq_content') {
          return jsonResponse({ data: [{
            id: 'f1', type: 'generic', status: 'published', geography_type: null, geography_id: null,
            translations: [{ languages_code: 'fr-BE', intro_text: null, qa_text: '<h2>Quel est le rôle ?</h2>' }],
          }] })
        }
        return jsonResponse({ data: [] })
      },
    })
    const detail = await getWorkfield(client, 'architect', { include: ['pricing', 'faq'], locale: 'fr-BE' })
    expect(detail.name).toBe('Architecte')
    expect(detail.isShadow).toBe(false)
    expect(detail.translation?.a_trade_singular).toBe('un architecte')
    expect(detail.translation).not.toHaveProperty('thumbnail')
    expect(detail.images.demandBannerUrl).toBe('https://cms.example.com/assets/32374472-3999-4330-aabb-aa1418b91adb')
    expect(detail.pricing).toEqual([{ id: 'p1', sort: 1, status: 'published', label: 'Plans', price_indication: 'de 2500€ à 4000€' }])
    expect(detail.faq).toEqual([{
      id: 'f1', type: 'generic', status: 'published', geographyType: undefined, geographyId: undefined,
      locale: 'fr-BE', introText: undefined, qaText: '<h2>Quel est le rôle ?</h2>',
    }])

    const pricing = new URL(urls.find((u) => u.includes('workfield_pricing_items')) ?? '')
    expect(JSON.parse(pricing.searchParams.get('filter') ?? '{}')).toEqual({
      workfield_content_id: { _eq: ARCHITECT_ID },
      languages_code: { _eq: 'fr-BE' },
    })
    const faq = new URL(urls.find((u) => u.includes('workfield_faq_content')) ?? '')
    expect(JSON.parse(faq.searchParams.get('filter') ?? '{}')).toEqual({
      workfield_content_id: { _eq: ARCHITECT_ID },
      type: { _eq: 'generic' },
    })
  })

  it('detail: unknown slug is a 404, and status only filters sub-rows', async () => {
    const urls: string[] = []
    const client = createDirectusClient({
      config: { url: 'https://cms.example.com', token: 't' },
      fetch: async (input) => {
        urls.push(input)
        const url = new URL(input)
        if (url.pathname === '/items/workfield_content') {
          return jsonResponse({ data: url.searchParams.get('filter')?.includes('nope') ? [] : [architectRow()] })
        }
        return jsonResponse({ data: [] })
      },
    })
    await expect(getWorkfield(client, 'nope', {})).rejects.toMatchObject({ status: 404 })
    await getWorkfield(client, 'architect', { include: ['blog'], status: 'draft' })
    const base = new URL(urls.find((u) => u.includes('workfield_content?')) ?? urls[0])
    expect(base.searchParams.get('filter')).not.toContain('status')
    const blog = new URL(urls.find((u) => u.includes('workfield_blog_content')) ?? '')
    expect(JSON.parse(blog.searchParams.get('filter') ?? '{}')).toMatchObject({ status: { _eq: 'draft' } })
  })

  it('faq route: filters by slug relation + geography, 404s an unknown workfield', async () => {
    const urls: string[] = []
    const client = createDirectusClient({
      config: { url: 'https://cms.example.com', token: 't' },
      fetch: async (input) => {
        urls.push(input)
        const url = new URL(input)
        if (url.pathname === '/items/workfield_faq_content') {
          return jsonResponse({ data: url.searchParams.get('filter')?.includes('roofer') ? [{
            id: 'l1', type: 'location_specific', status: 'published', geography_type: 'municipalities',
            geography_id: 'a107d1e4-84c8-45ae-b79e-7e206b055649',
            translations: [{ languages_code: 'fr-BE', intro_text: 'Intro', qa_text: 'QA' }],
          }] : [] })
        }
        return jsonResponse({ data: url.searchParams.get('filter')?.includes('roofer') ? [{ id: 'r' }] : [] })
      },
    })
    const rows = await listWorkfieldFaq(client, 'roofer', {
      type: 'location_specific', geographyType: 'municipalities', geographyId: 'a107d1e4-84c8-45ae-b79e-7e206b055649', locale: 'fr-BE',
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.introText).toBe('Intro')
    const faq = new URL(urls[0])
    expect(JSON.parse(faq.searchParams.get('filter') ?? '{}')).toEqual({
      workfield_content_id: { slug: { _eq: 'roofer' } },
      type: { _eq: 'location_specific' },
      geography_type: { _eq: 'municipalities' },
      geography_id: { _eq: 'a107d1e4-84c8-45ae-b79e-7e206b055649' },
    })
    await expect(listWorkfieldFaq(client, 'nope', {})).rejects.toBeInstanceOf(DirectusError)
  })
})
