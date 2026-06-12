/**
 * Task 5.4 — static re-bake correctness for template edits.
 *
 * An `everywhere` layout template wraps every baked page artefact, so:
 *   1. Editing/publishing the layout must re-bake the pages it wraps — proven
 *      here by asserting the baked `/about` artefact contains the layout's
 *      MASTHEAD header (the layout was applied on the static bake path).
 *   2. The template page itself must NEVER be baked at its own slug — it only
 *      ever wraps. Proven by asserting no `/layout` artefact exists.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DbResult } from '../../../server/db'
import { readArtefact } from '../../../server/publish/staticArtefact'
import { createFakeDb } from './dbTestFake'
import { makePage } from '../publisher/helpers'
import type { Page } from '../../../src/core/page-tree'

function rowDate(value: string) {
  return new Date(value)
}

function pageRow(page: Page, extraCells: Record<string, unknown> = {}) {
  return {
    id: page.id,
    table_id: 'pages',
    slug: page.slug,
    status: 'draft',
    cells_json: {
      title: page.title,
      slug: page.slug,
      body: { nodes: page.nodes, rootNodeId: page.rootNodeId },
      ...extraCells,
    },
    author_user_id: null, author_email: null, author_display_name: null,
    author_role_slug: null, author_role_name: null,
    created_by_user_id: null, created_by_email: null, created_by_display_name: null,
    created_by_role_slug: null, created_by_role_name: null,
    updated_by_user_id: null, updated_by_email: null, updated_by_display_name: null,
    updated_by_role_slug: null, updated_by_role_name: null,
    published_by_user_id: null, published_by_email: null, published_by_display_name: null,
    published_by_role_slug: null, published_by_role_name: null,
    created_at: rowDate('2026-01-01'), updated_at: rowDate('2026-01-01'),
    published_at: null, scheduled_publish_at: null, deleted_at: null,
  }
}

function buildFakeDb(layout: Page, about: Page) {
  return createFakeDb(async (sql: string, params: unknown[]): Promise<DbResult> => {
    const s = sql.replace(/\s+/g, ' ').trim().toLowerCase()

    if (s.startsWith('select id, name, version, enabled, lifecycle_status')) return { rows: [], rowCount: 0 }

    if (s.includes('from site') && s.includes('select id')) {
      return {
        rows: [{
          id: 'proj-1', name: 'Test Site',
          settings_json: { metaTitle: 'Test Site', shortcuts: {} },
          files_json: [], classes_json: {},
          breakpoints_json: [{ id: 'desktop', label: 'Desktop', width: 1440, icon: 'monitor' }],
          runtime_json: { dependencyLock: { version: 1, packages: {}, updatedAt: 0 }, scripts: {} },
          version: 1, created_at: rowDate('2026-01-01'), updated_at: rowDate('2026-01-01'),
        }],
        rowCount: 1,
      }
    }

    if (s.includes('select data_rows.id') && s.includes('from data_rows') && s.includes('order by')) {
      if (params[0] === 'pages') {
        return {
          rows: [
            pageRow(layout, {
              templateEnabled: true,
              templateTarget: { kind: 'everywhere' },
              templatePriority: 0,
            }),
            pageRow(about),
          ],
          rowCount: 2,
        }
      }
      return { rows: [], rowCount: 0 }
    }

    if (s.includes('coalesce(max(version_number), 0) + 1')) return { rows: [{ next_version: 1 }], rowCount: 1 }
    if (s.includes('insert into data_row_versions')) return { rows: [], rowCount: 1 }
    if (s.includes('insert into runtime_assets')) return { rows: [], rowCount: 0 }
    if (s.includes('select count') && s.includes('from runtime_assets')) return { rows: [{ count: 0 }], rowCount: 1 }
    if (s.includes('update data_rows') && s.includes("status = 'published'")) return { rows: [], rowCount: 1 }
    if (s.includes('from active_media_storage_adapter')) return { rows: [], rowCount: 0 }
    if (s.includes('count(*) as count from site')) return { rows: [{ count: 1 }], rowCount: 1 }

    return { rows: [], rowCount: 0 }
  })
}

describe('publishDraftSite — template re-bake', () => {
  let uploadsDir: string

  beforeEach(async () => {
    uploadsDir = await mkdtemp(join(tmpdir(), 'publish-rebake-'))
  })
  afterEach(async () => {
    await rm(uploadsDir, { recursive: true, force: true })
  })

  it('wraps baked pages in the everywhere layout and never bakes the template at its own slug', async () => {
    const layout = makePage({
      root: { moduleId: 'base.body', children: ['header', 'outlet'] },
      header: { moduleId: 'base.text', props: { text: 'MASTHEAD', tag: 'h1' } },
      outlet: { moduleId: 'base.outlet', props: { html: '' } },
    })
    layout.id = 'layout-tpl'
    layout.slug = 'layout'
    layout.title = 'Layout'
    layout.template = { enabled: true, target: { kind: 'everywhere' }, priority: 0 }

    const about = makePage({
      root: { moduleId: 'base.body', children: ['copy'] },
      copy: { moduleId: 'base.text', props: { text: 'ABOUT BODY', tag: 'p' } },
    })
    about.id = 'about'
    about.slug = 'about'
    about.title = 'About'

    const db = buildFakeDb(layout, about)
    const { publishDraftSite } = await import('../../../server/publish/publishSite')
    await publishDraftSite(db, 'user-1', uploadsDir)

    // /about is baked AND wrapped in the layout (MASTHEAD present + own body).
    const aboutHtml = await readArtefact(uploadsDir, '/about')
    expect(aboutHtml).not.toBeNull()
    expect(aboutHtml).toContain('MASTHEAD')
    expect(aboutHtml).toContain('ABOUT BODY')

    // The template page is never baked at its own slug.
    expect(await readArtefact(uploadsDir, '/layout')).toBeNull()
  })
})
