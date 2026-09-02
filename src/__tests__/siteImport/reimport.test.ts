/**
 * Importing the same site twice (#404).
 *
 * Drives the real store commit (`createSiteImportAdapter().commit` →
 * `mutateAllPagesAndSite`) so the test exercises the one place that decides
 * whether an incoming rule is "that rule arriving again" or a new one.
 */

import { describe, it, expect, beforeEach } from 'bun:test'
import '@modules/base'
import { useEditorStore } from '@site/store/store'
import { applyConflictResolutions, buildImportPlan, commitImportPlan } from '@core/siteImport'
import type { FileMap, ImportResult, SiteImportAdapter } from '@core/siteImport'
import type { StyleRule } from '@core/page-tree'
import { createSiteImportAdapter } from '@admin/modals/SiteImport/shared/createSiteImportAdapter'
import { makeSite } from '../fixtures'

const enc = new TextEncoder()

const INDEX_HTML =
  '<!doctype html><html><head><title>Home</title><link rel="stylesheet" href="style.css"></head>'
  + '<body><h1 class="hero">Hi</h1></body></html>'

/** The stylesheet declares `h1` twice on purpose — both declarations must survive. */
const STYLE_CSS = 'h1 { margin: 0 }\nbody { color: white }\nh1 { color: red }\n.hero { color: blue }\n'

function fileMap(css: string = STYLE_CSS): FileMap {
  return {
    files: {
      'index.html': { bytes: enc.encode(INDEX_HTML), mimeType: 'text/html' },
      'style.css': { bytes: enc.encode(css), mimeType: 'text/css' },
    },
  }
}

const USER_BODY_RULE: StyleRule = {
  id: 'user-body',
  name: 'body',
  kind: 'ambient',
  selector: 'body',
  order: 0,
  styles: { color: 'black' },
  contextStyles: {},
  createdAt: 1,
  updatedAt: 1,
}

async function importSite(css?: string): Promise<ImportResult> {
  const site = useEditorStore.getState().site!
  const plan = buildImportPlan({ fileMap: fileMap(css), currentSite: site })
  const resolved = applyConflictResolutions(
    plan,
    plan.conflicts.pages,
    plan.conflicts.rules,
    plan.conflicts.tokens,
    plan.conflicts.crossSheetClasses,
  )
  const adapter: SiteImportAdapter = {
    ...createSiteImportAdapter({ sessionId: 'reimport-test' }),
    uploadAsset: async () => {
      throw new Error('this fixture has no assets')
    },
  }
  return commitImportPlan(resolved, adapter)
}

function ambientRules(selector: string): Array<{ id: string; order: number; styles: Record<string, unknown> }> {
  const site = useEditorStore.getState().site!
  return Object.values(site.styleRules)
    .filter((rule) => rule.kind === 'ambient' && rule.selector === selector)
    .sort((a, b) => a.order - b.order)
    .map((rule) => ({ id: rule.id, order: rule.order, styles: rule.styles }))
}

describe('commitImportPlan — importing the same site twice', () => {
  beforeEach(() => {
    useEditorStore.setState({
      site: makeSite({ styleRules: { [USER_BODY_RULE.id]: { ...USER_BODY_RULE } } }),
    } as Parameters<typeof useEditorStore.setState>[0])
  })

  it('keeps one copy of every imported ambient rule, in place, with its cascade order', async () => {
    await importSite()
    const h1AfterFirst = ambientRules('h1')
    const bodyAfterFirst = ambientRules('body')
    expect(h1AfterFirst).toHaveLength(2)
    expect(bodyAfterFirst).toHaveLength(2) // the user's rule + the imported one

    await importSite()

    expect(ambientRules('h1').map((r) => [r.id, r.order]))
      .toEqual(h1AfterFirst.map((r) => [r.id, r.order]))
    expect(ambientRules('body').map((r) => [r.id, r.order]))
      .toEqual(bodyAfterFirst.map((r) => [r.id, r.order]))
  })

  it('leaves a user-authored ambient rule under the same selector untouched', async () => {
    await importSite()
    await importSite()

    const user = useEditorStore.getState().site!.styleRules[USER_BODY_RULE.id]!
    expect(user.styles).toEqual({ color: 'black' })
    expect(user.updatedAt).toBe(USER_BODY_RULE.updatedAt)
  })

  it('replaces a re-imported rule\'s declarations in place when the stylesheet changed', async () => {
    await importSite()
    const [importedBody] = ambientRules('body').filter((r) => r.id !== USER_BODY_RULE.id)
    expect(importedBody?.styles).toEqual({ color: 'white' })

    await importSite(STYLE_CSS.replace('body { color: white }', 'body { color: navy }'))

    const bodies = ambientRules('body').filter((r) => r.id !== USER_BODY_RULE.id)
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toEqual({ ...importedBody!, styles: { color: 'navy' } })
  })
})
