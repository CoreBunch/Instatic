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
import { cleanupPublishingTestDbs, createPublishingTestDb } from '../helpers/publishingTestDb'
import { makeSite } from '../publisher/helpers'
afterEach(cleanupPublishingTestDbs)
import { readArtefact } from '../../../server/publish/staticArtefact'
import { makePage } from '../publisher/helpers'

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

    const db = await createPublishingTestDb(makeSite({ pages: [layout, about], layouts: [] }), false)
    const { publishDraftSite } = await import('../../../server/publish/publishSite')
    await publishDraftSite(db, null, uploadsDir, { variants: [{ rowId: about.id, localeId: 'default' }] })

    // /about is baked AND wrapped in the layout (MASTHEAD present + own body).
    const aboutHtml = await readArtefact(uploadsDir, '/about')
    expect(aboutHtml).not.toBeNull()
    expect(aboutHtml).toContain('MASTHEAD')
    expect(aboutHtml).toContain('ABOUT BODY')

    // The template page is never baked at its own slug.
    expect(await readArtefact(uploadsDir, '/layout')).toBeNull()
  })
})
