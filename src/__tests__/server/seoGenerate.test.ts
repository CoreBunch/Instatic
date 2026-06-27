/**
 * SEO AI-suggestion endpoint tests — POST /admin/api/cms/seo/generate.
 *
 * The driver call itself needs a live provider, so these tests cover the
 * deterministic surface: capability gating (seo.manage + ai.chat), payload
 * validation, the no-default 409, and the tolerant model-output parser.
 */
import { beforeAll, afterAll, describe, expect, it } from 'bun:test'
import {
  createCapabilityTestHarness,
  expectForbidden,
  readJson,
  type CapabilityTestHarness,
} from '../helpers/capabilityHarness'
import { parseSuggestionsText } from '../../../server/handlers/cms/seoGenerate'

let h: CapabilityTestHarness
let owner: string
let pageId: string

beforeAll(async () => {
  h = await createCapabilityTestHarness()
  owner = await h.setupOwner()
  const res = await h.cms('/admin/api/cms/seo/targets', { cookie: owner })
  const body = await readJson<{ targets: { kind: string; id: string }[] }>(res)
  pageId = body.targets.find((t) => t.kind === 'page')!.id
})

afterAll(async () => {
  await h.cleanup()
})

describe('POST /admin/api/cms/seo/generate', () => {
  it('rejects invalid payloads', async () => {
    const res = await h.cms('/admin/api/cms/seo/generate', {
      method: 'POST',
      cookie: owner,
      json: { kind: 'page', id: pageId, field: 'canonicalUrl' },
    })
    expect(res.status).toBe(400)
  })

  it('404s for unknown targets', async () => {
    const res = await h.cms('/admin/api/cms/seo/generate', {
      method: 'POST',
      cookie: owner,
      json: { kind: 'page', id: 'missing', field: 'title' },
    })
    expect(res.status).toBe(404)
  })

  it('409s with an actionable message when no AI default is configured', async () => {
    const res = await h.cms('/admin/api/cms/seo/generate', {
      method: 'POST',
      cookie: owner,
      json: { kind: 'page', id: pageId, field: 'title' },
    })
    expect(res.status).toBe(409)
    const body = await readJson<{ error: string }>(res)
    expect(body.error).toContain('No AI provider configured')
  })

  it('requires seo.manage AND ai.chat', async () => {
    const noAi = await h.createRoleUser({
      name: 'SEO no AI',
      slug: 'seo-no-ai',
      capabilities: ['seo.read', 'seo.manage'],
    })
    await expectForbidden(await h.cms('/admin/api/cms/seo/generate', {
      method: 'POST',
      cookie: noAi.cookie,
      json: { kind: 'page', id: pageId, field: 'title' },
    }))

    const noSeo = await h.createRoleUser({
      name: 'AI no SEO',
      slug: 'ai-no-seo',
      capabilities: ['ai.chat'],
    })
    await expectForbidden(await h.cms('/admin/api/cms/seo/generate', {
      method: 'POST',
      cookie: noSeo.cookie,
      json: { kind: 'page', id: pageId, field: 'title' },
    }))
  })
})

describe('parseSuggestionsText', () => {
  it('parses a clean JSON array', () => {
    expect(parseSuggestionsText('["One", "Two", "Three"]')).toEqual(['One', 'Two', 'Three'])
  })

  it('extracts the array from surrounding prose and fences', () => {
    const text = 'Here you go:\n```json\n["A", "B", "C"]\n```\nEnjoy!'
    expect(parseSuggestionsText(text)).toEqual(['A', 'B', 'C'])
  })

  it('dedupes, trims, and caps at three', () => {
    expect(parseSuggestionsText('[" A ", "A", "B", "C", "D"]')).toEqual(['A', 'B', 'C'])
  })

  it('returns null for garbage', () => {
    expect(parseSuggestionsText('no array here')).toBeNull()
    expect(parseSuggestionsText('[]')).toBeNull()
    expect(parseSuggestionsText('[1, 2, 3]')).toBeNull()
  })
})
