/**
 * History coalescing fold — per-path patch dedup inside a typing burst.
 *
 * `commitHistory` folds consecutive same-`coalesceKey` entries into the top
 * history entry. The fold must keep AT MOST one inverse and one forward patch
 * per touched path (oldest inverse wins, newest forward value wins) instead of
 * accumulating 2K patch pairs over a K-keystroke burst — while keeping
 * undo/redo results bit-identical:
 *
 *   1. Burst on an existing prop: undo → original value, redo → final value.
 *   2. Burst that CREATES a prop (add-op first keystroke): undo → prop absent,
 *      redo (from the prop-absent state) → final value.
 *   3. Burst touching two paths (the prop + the `site.updatedAt` stamp that
 *      `runHistoricMutation` appends): both paths revert and replay correctly.
 *   4. Size bound: a 100-keystroke burst leaves at most one patch per touched
 *      path per direction in the top entry.
 *   5. Pin the Mutative `apply()` behavior the fold relies on: 'add' and
 *      'replace' are interchangeable for plain-object keys.
 */
import { describe, it, expect, beforeEach } from 'bun:test'
import { apply } from 'mutative'
import type { Patches } from 'mutative'
import { useEditorStore } from '@site/store/store'
import '@modules/base/index'

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
    _historyCoalesceKey: null,
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
  } as Parameters<typeof useEditorStore.setState>[0])
}

beforeEach(freshStore)

/** Create a site with one text node and return its id. */
function setupTextNode(initialProps: Record<string, unknown> = { text: '' }): string {
  const site = useEditorStore.getState().createSite('Fold Test')
  const rootId = site.pages[0].rootNodeId
  return useEditorStore.getState().insertNode('base.text', initialProps, rootId)
}

function pathKey(path: Patches[number]['path']): string {
  return JSON.stringify(path)
}

describe('history coalescing — fold correctness', () => {
  it('burst on an existing prop: undo → original value, redo → final value', () => {
    const nodeId = setupTextNode({ text: 'original' })

    for (const text of ['a', 'ab', 'abc', 'abcd']) {
      useEditorStore.getState().updateNodeProps(nodeId, { text })
    }
    expect(useEditorStore.getState().site!.pages[0].nodes[nodeId].props.text).toBe('abcd')

    useEditorStore.getState().undo()
    expect(useEditorStore.getState().site!.pages[0].nodes[nodeId].props.text).toBe('original')

    useEditorStore.getState().redo()
    expect(useEditorStore.getState().site!.pages[0].nodes[nodeId].props.text).toBe('abcd')
  })

  it('burst that CREATES a prop: undo → prop absent, redo → final value', () => {
    const nodeId = setupTextNode({ text: 'hello' })

    // `title` does not exist on the node yet — the first keystroke's forward
    // patch is 'add'-shaped, and the folded forward patch must stay applicable
    // from the post-undo state where the prop is absent.
    for (const title of ['t', 'ti', 'tit', 'title']) {
      useEditorStore.getState().updateNodeProps(nodeId, { title })
    }
    expect(useEditorStore.getState().site!.pages[0].nodes[nodeId].props.title).toBe('title')

    useEditorStore.getState().undo()
    const propsAfterUndo = useEditorStore.getState().site!.pages[0].nodes[nodeId].props
    expect('title' in propsAfterUndo).toBe(false)
    expect(propsAfterUndo.text).toBe('hello')

    useEditorStore.getState().redo()
    expect(useEditorStore.getState().site!.pages[0].nodes[nodeId].props.title).toBe('title')
  })

  it("the folded forward patch for a burst-created prop keeps the oldest 'add' op", () => {
    const nodeId = setupTextNode({ text: 'hello' })
    for (const title of ['t', 'ti', 'tit']) {
      useEditorStore.getState().updateNodeProps(nodeId, { title })
    }

    const top = useEditorStore.getState()._historyPast.at(-1)!
    const titlePatch = top.forward.find((p) => Array.isArray(p.path) && p.path.at(-1) === 'title')
    expect(titlePatch).toBeDefined()
    expect(titlePatch!.op).toBe('add')
    expect(titlePatch!.value).toBe('tit')
  })

  it('burst touching two paths: prop AND site.updatedAt both revert and replay', () => {
    const nodeId = setupTextNode({ text: 'start' })

    // Force a sentinel timestamp so the pre-burst value is distinguishable
    // from anything Date.now() can produce during the burst.
    const site = useEditorStore.getState().site!
    useEditorStore.setState({ site: { ...site, updatedAt: 1000 } })

    for (const text of ['x', 'xy', 'xyz']) {
      useEditorStore.getState().updateNodeProps(nodeId, { text })
    }
    const updatedAtAfterBurst = useEditorStore.getState().site!.updatedAt
    expect(updatedAtAfterBurst).not.toBe(1000)

    useEditorStore.getState().undo()
    expect(useEditorStore.getState().site!.updatedAt).toBe(1000)
    expect(useEditorStore.getState().site!.pages[0].nodes[nodeId].props.text).toBe('start')

    useEditorStore.getState().redo()
    expect(useEditorStore.getState().site!.updatedAt).toBe(updatedAtAfterBurst)
    expect(useEditorStore.getState().site!.pages[0].nodes[nodeId].props.text).toBe('xyz')
  })

  it('undo + redo round-trips a burst bit-identically', () => {
    const nodeId = setupTextNode({ text: 'seed' })
    for (let i = 1; i <= 10; i++) {
      useEditorStore.getState().updateNodeProps(nodeId, { text: 'seed'.repeat(i) })
    }

    const afterBurst = JSON.stringify(useEditorStore.getState().site)
    useEditorStore.getState().undo()
    useEditorStore.getState().redo()
    expect(JSON.stringify(useEditorStore.getState().site)).toBe(afterBurst)
  })
})

describe('history coalescing — fold size bound', () => {
  it('a 100-keystroke burst keeps at most one patch per path per direction', () => {
    const nodeId = setupTextNode({ text: '' })
    const depthBefore = useEditorStore.getState()._historyPast.length

    for (let i = 1; i <= 100; i++) {
      useEditorStore.getState().updateNodeProps(nodeId, { text: 'x'.repeat(i) })
    }

    const past = useEditorStore.getState()._historyPast
    // Still exactly one coalesced entry for the whole burst.
    expect(past.length).toBe(depthBefore + 1)

    const top = past.at(-1)!
    for (const direction of [top.inverse, top.forward]) {
      const paths = direction.map((p) => pathKey(p.path))
      // No duplicate paths — the burst touched 2 paths (the prop + updatedAt),
      // so each direction holds at most 2 patches, not ~200.
      expect(new Set(paths).size).toBe(paths.length)
      expect(direction.length).toBeLessThanOrEqual(2)
    }

    // The fold must not have broken undo/redo.
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().site!.pages[0].nodes[nodeId].props.text).toBe('')
    useEditorStore.getState().redo()
    expect(useEditorStore.getState().site!.pages[0].nodes[nodeId].props.text).toBe('x'.repeat(100))
  })
})

describe('mutative apply() op semantics the fold relies on', () => {
  it("treats 'add' and 'replace' identically for plain-object keys", () => {
    // Verified against mutative@1.3.0 src/apply.ts: for plain objects both ops
    // run `base[key] = value`. (They differ ONLY for array indices, where
    // 'add' splices — coalescing recipes never patch array tails.) This pin
    // fails if a mutative upgrade changes that contract.
    const base = { props: { existing: 1 } as Record<string, unknown> }
    const viaAdd = apply(base, [{ op: 'add', path: ['props', 'k'], value: 'v' }] as Patches)
    const viaReplace = apply(base, [{ op: 'replace', path: ['props', 'k'], value: 'v' }] as Patches)
    expect(viaAdd).toEqual(viaReplace)

    // 'remove' deletes the key, and deleting an absent key is a no-op — the
    // fold may therefore collapse any op sequence involving 'remove' to the
    // newest patch wholesale.
    const removed = apply(base, [{ op: 'remove', path: ['props', 'absent'] }] as Patches)
    expect(removed).toEqual(base)
  })
})
