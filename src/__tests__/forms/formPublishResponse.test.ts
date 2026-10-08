import { describe, expect, it } from 'bun:test'
import { createCapabilityTestHarness, readJson } from '../helpers/capabilityHarness'
import { createDataRow } from '../../../server/repositories/data'
import { MAIN_SCOPE } from '../../../server/branches/scope'
import { pageToCells } from '@core/data/pageFromRow'
import { makePage, makeNode } from '../fixtures'

describe('native form publication errors', () => {
  it('returns an actionable 422 path and preserves an empty publication state', async () => {
    const harness = await createCapabilityTestHarness()
    try {
      const cookie = await harness.setupOwner()
      const { rows: owners } = await harness.db<{ id: string }>`select id from users limit 1`
      const page = makePage({ id: 'form-page', slug: 'native-form', nodes: {
        root: makeNode({ id: 'root', moduleId: 'base.body', children: ['form'] }),
        form: makeNode({ id: 'form', moduleId: 'base.form', props: { mode: 'request', formId: 'contact', action: 'javascript:invalid' } }),
      } })
      await createDataRow(harness.db, MAIN_SCOPE, { id: page.id, tableId: 'pages', cells: pageToCells(page), slug: page.slug }, owners[0].id)
      const response = await harness.cms('/admin/api/cms/publish', { method: 'POST', cookie })
      expect(response.status).toBe(422)
      const body = await readJson<{ error: string }>(response)
      expect(body.error).toContain('pages.form-page.nodes.form')
      expect(body.error).toContain('HTTP(S) URL')
      const { rows } = await harness.db<{ count: number }>`select count(*) as count from site_snapshots`
      expect(rows[0].count).toBe(0)
    } finally { await harness.cleanup() }
  }, 15_000)
})
