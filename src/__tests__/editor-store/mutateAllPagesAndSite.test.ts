/**
 * Tests for `mutateAllPagesAndSite` and the extracted `importLinking` module.
 *
 * Coverage:
 *  1. Basic happy path — addPage and addStyleRule produce new entries with
 *     fresh ids + timestamps.
 *  2. Atomicity — one recipe that calls all four helpers produces exactly one
 *     history snapshot; a single undo reverts everything.
 *  3. Name→id linking — addPage with fragment nodes whose classIds contain
 *     class *names* resolves them to real registry ids and auto-creates bare
 *     StyleRules for unknown names.
 *  4. Cross-helper dedup — addStyleRule('btn') then addPage(node with 'btn')
 *     shares the same registry id (shared byName map).
 *  5. No-op recipe — returning false produces no history entry.
 *  6. Missing-id errors — overwritePage / overwriteStyleRule on non-existent
 *     ids throw.
 *  7. Regression — pre-existing insertImportedNodes / linkImportedClassNames
 *     behaviour still passes after the linking refactor.
 */

import { beforeEach, describe, expect, it } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import type { ImportFragment } from '@core/htmlImport'
import { makePage, makeSite, makeNode } from '../fixtures'
import '@modules/base/index'

// ---------------------------------------------------------------------------
// Store reset helpers
// ---------------------------------------------------------------------------

function freshStore(): void {
  useEditorStore.setState({
    site: null,
    activePageId: null,
    activeDocument: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
  } as Parameters<typeof useEditorStore.setState>[0])
}

beforeEach(freshStore)

/**
 * Build a minimal ImportFragment whose nodes have class *names* on classIds
 * (mimicking what walkAndMap produces — names, not registry ids).
 */
function makeFragment(classNames: string[] = []): ImportFragment {
  const nodeId = 'frag-node-1'
  return {
    nodes: {
      [nodeId]: {
        id: nodeId,
        moduleId: 'base.text',
        props: { text: 'Hello' },
        breakpointOverrides: {},
        children: [],
        classIds: classNames,
      },
    },
    rootIds: [nodeId],
  }
}

/** Fragment with one node carrying an inline background image in `inlineStyles`. */
function makeBgFragment(bgUrl: string): ImportFragment {
  const nodeId = 'frag-bg-1'
  return {
    nodes: {
      [nodeId]: {
        id: nodeId,
        moduleId: 'base.container',
        props: { tag: 'section' },
        breakpointOverrides: {},
        children: [],
        classIds: [],
        inlineStyles: { backgroundImage: `url('${bgUrl}')` },
      },
    },
    rootIds: [nodeId],
  }
}

// ---------------------------------------------------------------------------
// 1. Basic happy path
// ---------------------------------------------------------------------------

describe('mutateAllPagesAndSite — basic happy path', () => {
  it('addPage creates a page in site.pages with a fresh id', () => {
    const store = useEditorStore.getState()
    store.createSite('Test')

    const before = useEditorStore.getState().site!.pages.length

    useEditorStore.getState().mutateAllPagesAndSite((site, helpers) => {
      helpers.addPage({ title: 'New Page', slug: 'new-page', nodeFragment: makeFragment() })
      return true
    })

    const after = useEditorStore.getState().site!.pages
    expect(after.length).toBe(before + 1)
    const newPage = after[after.length - 1]!
    expect(typeof newPage.id).toBe('string')
    expect(newPage.title).toBe('New Page')
    expect(newPage.slug).toBe('new-page')
  })

  it('addStyleRule creates an entry in site.styleRules with fresh id and timestamps', () => {
    const store = useEditorStore.getState()
    store.createSite('Test')

    let addedId = ''
    useEditorStore.getState().mutateAllPagesAndSite((_site, helpers) => {
      addedId = helpers.addStyleRule({
        name: 'hero',
        kind: 'class',
        selector: '.hero',
        order: 0,
        styles: { color: 'red' },
        contextStyles: {},
      })
      return true
    })

    const rules = useEditorStore.getState().site!.styleRules
    expect(addedId).toBeTruthy()
    expect(rules[addedId]).toBeDefined()
    expect(rules[addedId]!.name).toBe('hero')
    expect(typeof rules[addedId]!.createdAt).toBe('number')
    expect(typeof rules[addedId]!.updatedAt).toBe('number')
    expect(rules[addedId]!.createdAt).toBeGreaterThan(0)
  })

  it('addPage returns the new page id which matches the page in site.pages', () => {
    useEditorStore.getState().createSite('Test')

    let returnedId = ''
    useEditorStore.getState().mutateAllPagesAndSite((_site, helpers) => {
      returnedId = helpers.addPage({ title: 'Page', slug: 'page', nodeFragment: makeFragment() })
      return true
    })

    const pages = useEditorStore.getState().site!.pages
    const matchingPage = pages.find((p) => p.id === returnedId)
    expect(matchingPage).toBeDefined()
  })

  it('addScripts installs imported runtime dependencies in the same undoable mutation', () => {
    useEditorStore.getState().createSite('Test')

    useEditorStore.getState().mutateAllPagesAndSite((_site, helpers) => {
      helpers.addScripts([{
        path: 'motion.js',
        content: `import { Motion } from '@motion.page/sdk';`,
        format: 'module',
        pageSources: ['index.html'],
        priority: 100,
        dependencies: [{ name: '@motion.page/sdk', version: '1.2.4' }],
      }])
      return true
    })

    expect(useEditorStore.getState().packageJson.dependencies['@motion.page/sdk']).toBe('1.2.4')
    expect(useEditorStore.getState().site?.packageJson.dependencies['@motion.page/sdk']).toBe('1.2.4')

    useEditorStore.getState().undo()

    expect(useEditorStore.getState().packageJson.dependencies['@motion.page/sdk']).toBeUndefined()
    expect(useEditorStore.getState().site?.packageJson.dependencies['@motion.page/sdk']).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 2. Atomicity — one history snapshot for the whole recipe
// ---------------------------------------------------------------------------

describe('mutateAllPagesAndSite — atomicity', () => {
  it('all four helpers in one recipe produce exactly one history snapshot', () => {
    useEditorStore.getState().createSite('Test')

    // Seed an existing page and style rule to overwrite.
    let existingPageId = ''
    let existingRuleId = ''
    useEditorStore.getState().mutateAllPagesAndSite((_site, helpers) => {
      existingPageId = helpers.addPage({ title: 'Old', slug: 'old', nodeFragment: makeFragment() })
      existingRuleId = helpers.addStyleRule({
        name: 'old-rule',
        kind: 'class',
        selector: '.old-rule',
        order: 0,
        styles: {},
        contextStyles: {},
      })
      return true
    })

    // Now run the four-helper recipe.
    useEditorStore.getState().mutateAllPagesAndSite((_site, helpers) => {
      helpers.addPage({ title: 'Added', slug: 'added', nodeFragment: makeFragment() })
      helpers.addStyleRule({ name: 'new-rule', kind: 'class', selector: '.new-rule', order: 0, styles: {}, contextStyles: {} })
      helpers.overwritePage(existingPageId, { title: 'Updated', slug: 'updated', nodeFragment: makeFragment() })
      helpers.overwriteStyleRule(existingRuleId, { name: 'old-rule', kind: 'class', selector: '.old-rule', order: 0, styles: { color: 'blue' }, contextStyles: {} })
      return true
    })

    // Exactly ONE history snapshot: a single undo reverts all four helpers.
    useEditorStore.getState().undo()
    const site = useEditorStore.getState().site!
    expect(site.pages.some((p) => p.slug === 'added')).toBe(false)
    expect(Object.values(site.styleRules).some((r) => r.name === 'new-rule')).toBe(false)
    expect(site.pages.find((p) => p.id === existingPageId)?.title).toBe('Old')
    expect(site.styleRules[existingRuleId]?.styles.color).toBeUndefined()
  })

  it('undo after the four-helper recipe reverts ALL four mutations in one press', () => {
    useEditorStore.getState().createSite('Test')

    let existingPageId = ''
    let existingRuleId = ''
    useEditorStore.getState().mutateAllPagesAndSite((_site, helpers) => {
      existingPageId = helpers.addPage({ title: 'Seed Page', slug: 'seed', nodeFragment: makeFragment() })
      existingRuleId = helpers.addStyleRule({ name: 'seed-rule', kind: 'class', selector: '.seed-rule', order: 0, styles: {}, contextStyles: {} })
      return true
    })

    const snapshotPages = useEditorStore.getState().site!.pages.length
    const snapshotRules = Object.keys(useEditorStore.getState().site!.styleRules).length
    const snapshotPageTitle = useEditorStore.getState().site!.pages.find((p) => p.id === existingPageId)!.title

    useEditorStore.getState().mutateAllPagesAndSite((_site, helpers) => {
      helpers.addPage({ title: 'Extra', slug: 'extra', nodeFragment: makeFragment() })
      helpers.addStyleRule({ name: 'extra-rule', kind: 'class', selector: '.extra-rule', order: 0, styles: {}, contextStyles: {} })
      helpers.overwritePage(existingPageId, { title: 'Overwritten', slug: 'overwritten', nodeFragment: makeFragment() })
      helpers.overwriteStyleRule(existingRuleId, { name: 'seed-rule', kind: 'class', selector: '.seed-rule', order: 0, styles: { opacity: '0.5' }, contextStyles: {} })
      return true
    })

    // Verify mutations landed.
    const afterPages = useEditorStore.getState().site!.pages.length
    const afterRules = Object.keys(useEditorStore.getState().site!.styleRules).length
    expect(afterPages).toBe(snapshotPages + 1)
    expect(afterRules).toBe(snapshotRules + 1)

    // One undo should revert everything.
    useEditorStore.getState().undo()

    const undoPages = useEditorStore.getState().site!.pages.length
    const undoRules = Object.keys(useEditorStore.getState().site!.styleRules).length
    const undoTitle = useEditorStore.getState().site!.pages.find((p) => p.id === existingPageId)!.title

    expect(undoPages).toBe(snapshotPages)
    expect(undoRules).toBe(snapshotRules)
    expect(undoTitle).toBe(snapshotPageTitle)
  })
})

// ---------------------------------------------------------------------------
// 3. Name→id linking
// ---------------------------------------------------------------------------

describe('mutateAllPagesAndSite — name→id linking', () => {
  it('nodes with class names on classIds get real registry ids after addPage', () => {
    useEditorStore.getState().createSite('Test')

    const ruleCountBefore = Object.keys(useEditorStore.getState().site!.styleRules).length
    const fragment = makeFragment(['my-class', 'other-class'])

    let newPageId = ''
    useEditorStore.getState().mutateAllPagesAndSite((_site, helpers) => {
      newPageId = helpers.addPage({ title: 'Linked', slug: 'linked', nodeFragment: fragment })
      return true
    })

    const { site } = useEditorStore.getState()
    const page = site!.pages.find((p) => p.id === newPageId)!
    const fragNode = page.nodes['frag-node-1']!

    // classIds should now be registry ids, not the original name strings
    expect(fragNode.classIds).toHaveLength(2)
    expect(fragNode.classIds).not.toContain('my-class')
    expect(fragNode.classIds).not.toContain('other-class')

    // Both names should have spawned new StyleRules
    const ruleCountAfter = Object.keys(site!.styleRules).length
    expect(ruleCountAfter).toBe(ruleCountBefore + 2)

    // Each new rule should be kind:'class' with the correct name
    const allRules = Object.values(site!.styleRules)
    const myClassRule = allRules.find((r) => r.name === 'my-class')
    const otherClassRule = allRules.find((r) => r.name === 'other-class')
    expect(myClassRule).toBeDefined()
    expect(myClassRule!.kind).toBe('class')
    expect(myClassRule!.selector).toBe('.my-class')
    expect(otherClassRule).toBeDefined()

    // The node's classIds should contain the newly-created rule ids
    expect(fragNode.classIds).toContain(myClassRule!.id)
    expect(fragNode.classIds).toContain(otherClassRule!.id)
  })

  it('existing class names are resolved to their existing rule ids (no duplicates)', () => {
    useEditorStore.getState().createSite('Test')

    // Pre-create a class rule named 'existing-cls'
    let existingId = ''
    useEditorStore.getState().mutateAllPagesAndSite((_site, helpers) => {
      existingId = helpers.addStyleRule({
        name: 'existing-cls',
        kind: 'class',
        selector: '.existing-cls',
        order: 0,
        styles: { color: 'green' },
        contextStyles: {},
      })
      return true
    })

    const ruleCountBefore = Object.keys(useEditorStore.getState().site!.styleRules).length
    const fragment = makeFragment(['existing-cls'])

    let newPageId = ''
    useEditorStore.getState().mutateAllPagesAndSite((_site, helpers) => {
      newPageId = helpers.addPage({ title: 'Reuse', slug: 'reuse', nodeFragment: fragment })
      return true
    })

    const { site } = useEditorStore.getState()
    const page = site!.pages.find((p) => p.id === newPageId)!
    const fragNode = page.nodes['frag-node-1']!

    // Should have reused the existing rule, not created a new one
    expect(Object.keys(site!.styleRules).length).toBe(ruleCountBefore)
    expect(fragNode.classIds).toContain(existingId)
    expect(fragNode.classIds).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// 3b. Inline background → node.inlineStyles rides along on insert
// ---------------------------------------------------------------------------

describe('inline background carries through to node.inlineStyles', () => {
  it('addPage preserves the imported node inlineStyles (no class created)', () => {
    useEditorStore.getState().createSite('Test')

    const rulesBefore = Object.keys(useEditorStore.getState().site!.styleRules).length
    let newPageId = ''
    useEditorStore.getState().mutateAllPagesAndSite((_site, helpers) => {
      newPageId = helpers.addPage({
        title: 'Bg', slug: 'bg', nodeFragment: makeBgFragment('/uploads/media/hero.png'),
      })
      return true
    })

    const { site } = useEditorStore.getState()
    const node = site!.pages.find((p) => p.id === newPageId)!.nodes['frag-bg-1']!

    // Inline styles ride along on the node; no class id, no new style rule.
    expect(node.classIds).toHaveLength(0)
    expect(node.inlineStyles?.backgroundImage).toBe(`url('/uploads/media/hero.png')`)
    expect(Object.keys(site!.styleRules).length).toBe(rulesBefore)
  })

  it('insertImportedNodes preserves the imported node inlineStyles', () => {
    const site = useEditorStore.getState().createSite('Test')
    const rootId = site.pages[0]!.rootNodeId

    useEditorStore.getState().insertImportedNodes(rootId, makeBgFragment('/uploads/media/x.png'))

    const node = useEditorStore.getState().site!.pages[0]!.nodes['frag-bg-1']!
    expect(node.inlineStyles?.backgroundImage).toBe(`url('/uploads/media/x.png')`)
  })
})

// ---------------------------------------------------------------------------
// 4. Cross-helper dedup — shared byName map
// ---------------------------------------------------------------------------

describe('mutateAllPagesAndSite — cross-helper dedup', () => {
  it('addStyleRule then addPage referencing same name resolves to same id', () => {
    useEditorStore.getState().createSite('Test')

    let addedRuleId = ''
    let newPageId = ''

    useEditorStore.getState().mutateAllPagesAndSite((_site, helpers) => {
      // Step 1: add a class rule named 'btn'
      addedRuleId = helpers.addStyleRule({
        name: 'btn',
        kind: 'class',
        selector: '.btn',
        order: 0,
        styles: { padding: '8px' },
        contextStyles: {},
      })
      // Step 2: add a page whose fragment node references 'btn' by name
      newPageId = helpers.addPage({
        title: 'Page',
        slug: 'page',
        nodeFragment: makeFragment(['btn']),
      })
      return true
    })

    const { site } = useEditorStore.getState()
    const page = site!.pages.find((p) => p.id === newPageId)!
    const fragNode = page.nodes['frag-node-1']!

    // No duplicate 'btn' rule should have been created
    const btnRules = Object.values(site!.styleRules).filter((r) => r.name === 'btn')
    expect(btnRules).toHaveLength(1)

    // The node's classId should reference the rule added by addStyleRule
    expect(fragNode.classIds).toContain(addedRuleId)
    expect(fragNode.classIds).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// 5. No-op recipe
// ---------------------------------------------------------------------------

describe('mutateAllPagesAndSite — no-op recipe', () => {
  it('a recipe that returns false produces no history entry and no dirty flag', () => {
    useEditorStore.getState().createSite('Test')

    const historyBefore = useEditorStore.getState()._historyPast.length
    const updatedAtBefore = useEditorStore.getState().site!.updatedAt

    const changed = useEditorStore.getState().mutateAllPagesAndSite((_site, _helpers) => {
      return false
    })

    expect(changed).toBe(false)
    expect(useEditorStore.getState()._historyPast.length).toBe(historyBefore)
    expect(useEditorStore.getState().hasUnsavedChanges).toBe(false)
    expect(useEditorStore.getState().site!.updatedAt).toBe(updatedAtBefore)
  })

  it('a recipe that calls no helpers but returns void produces no history entry', () => {
    useEditorStore.getState().createSite('Test')

    const historyBefore = useEditorStore.getState()._historyPast.length

    const changed = useEditorStore.getState().mutateAllPagesAndSite((_site, _helpers) => {
      // intentionally calls no helpers
    })

    // recipeDidMutate(void) = true but didMutate = false → no snapshot
    expect(changed).toBe(false)
    expect(useEditorStore.getState()._historyPast.length).toBe(historyBefore)
  })
})

// ---------------------------------------------------------------------------
// 6. Missing-id errors
// ---------------------------------------------------------------------------

describe('mutateAllPagesAndSite — missing-id errors', () => {
  it('overwritePage throws when pageId is not found', () => {
    useEditorStore.getState().createSite('Test')

    expect(() => {
      useEditorStore.getState().mutateAllPagesAndSite((_site, helpers) => {
        helpers.overwritePage('nonexistent-page', {
          title: 'X',
          slug: 'x',
          nodeFragment: makeFragment(),
        })
        return true
      })
    }).toThrow('overwritePage: page not found')
  })

  it('overwriteStyleRule throws when ruleId is not found', () => {
    useEditorStore.getState().createSite('Test')

    expect(() => {
      useEditorStore.getState().mutateAllPagesAndSite((_site, helpers) => {
        helpers.overwriteStyleRule('nonexistent-rule', {
          name: 'x',
          kind: 'class',
          selector: '.x',
          order: 0,
          styles: {},
          contextStyles: {},
        })
        return true
      })
    }).toThrow('overwriteStyleRule: style rule not found')
  })
})

// ---------------------------------------------------------------------------
// 7. Regression — insertImportedNodes / linkImportedClassNames still work
// ---------------------------------------------------------------------------

describe('insertImportedNodes regression — linking refactor', () => {
  it('class names on fragment nodes are linked to registry ids when inserted into page', () => {
    const site = useEditorStore.getState().createSite('Test')
    const rootId = site.pages[0]!.rootNodeId

    const fragment = makeFragment(['hero-title'])

    const insertedIds = useEditorStore.getState().insertImportedNodes(rootId, fragment)
    expect(insertedIds).toHaveLength(1)

    const { site: updatedSite } = useEditorStore.getState()
    const page = updatedSite!.pages[0]!
    const insertedNode = page.nodes['frag-node-1']!

    // classIds should be a real registry id, not the name string
    expect(insertedNode.classIds).not.toContain('hero-title')
    expect(insertedNode.classIds).toHaveLength(1)

    // A StyleRule for 'hero-title' should have been auto-created
    const rules = Object.values(updatedSite!.styleRules)
    const heroRule = rules.find((r) => r.name === 'hero-title')
    expect(heroRule).toBeDefined()
    expect(heroRule!.kind).toBe('class')
    expect(insertedNode.classIds[0]).toBe(heroRule!.id)
  })
})
