/**
 * Store actions for the unified editing-context model.
 *
 * Custom conditions are site-level (`site.conditions`); a class carries an
 * override bag per context in `contextStyles`. Actions: addClassCondition /
 * setClassContextStyles / removeClassContext / addCondition / removeCondition.
 */

import { describe, it, expect } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import { conditionId } from '@core/page-tree'
import '@modules/base'

function freshStore() {
  useEditorStore.setState({
    site: null,
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
    activeClassId: null,
    isAgentOpen: false,
    isAgentStreaming: false,
    agentMessages: [],
    agentError: null,
    hasUnsavedChanges: false,
  })
  useEditorStore.getState().createSite('Test')
}

function classId(): string {
  return useEditorStore.getState().createClass('card').id
}

describe('addClassCondition', () => {
  it('registers the condition and opens an override bag on the class', () => {
    freshStore()
    const id = classId()
    const cid = useEditorStore.getState().addClassCondition(id, {
      kind: 'media',
      query: '(max-width: 860px)',
    })
    expect(cid).toBe(conditionId({ kind: 'media', query: '(max-width: 860px)' }))
    const site = useEditorStore.getState().site!
    expect(site.conditions).toHaveLength(1)
    expect(site.conditions![0].condition).toEqual({ kind: 'media', query: '(max-width: 860px)' })
    expect(site.styleRules[id].contextStyles[cid!]).toEqual({})
  })

  it('reuses the existing condition id for an identical condition', () => {
    freshStore()
    const id = classId()
    const a = useEditorStore.getState().addClassCondition(id, { kind: 'media', query: '(min-width: 1px)' })
    const b = useEditorStore.getState().addClassCondition(id, { kind: 'media', query: '(min-width: 1px)' })
    expect(a).toBe(b)
    expect(useEditorStore.getState().site!.conditions).toHaveLength(1)
  })

  it('container conditions distinguish by name', () => {
    freshStore()
    const id = classId()
    useEditorStore.getState().addClassCondition(id, { kind: 'container', query: '(min-width: 400px)', name: 'a' })
    useEditorStore.getState().addClassCondition(id, { kind: 'container', query: '(min-width: 400px)', name: 'b' })
    expect(useEditorStore.getState().site!.conditions).toHaveLength(2)
  })
})

describe('setClassContextStyles', () => {
  it('merges a style patch into the context bag', () => {
    freshStore()
    const id = classId()
    const cid = useEditorStore.getState().addClassCondition(id, { kind: 'media', query: '(max-width: 860px)' })!
    useEditorStore.getState().setClassContextStyles(id, cid, { color: 'red' })
    useEditorStore.getState().setClassContextStyles(id, cid, { fontSize: '14px' })
    expect(useEditorStore.getState().site!.styleRules[id].contextStyles[cid]).toMatchObject({
      color: 'red',
      fontSize: '14px',
    })
  })

  it('an undefined value deletes the property from the context bag', () => {
    freshStore()
    const id = classId()
    const cid = useEditorStore.getState().addClassCondition(id, { kind: 'media', query: '(max-width: 860px)' })!
    useEditorStore.getState().setClassContextStyles(id, cid, { color: 'red' })
    useEditorStore.getState().setClassContextStyles(id, cid, { color: undefined })
    expect(useEditorStore.getState().site!.styleRules[id].contextStyles[cid]).not.toHaveProperty('color')
  })
})

describe('removeClassContext', () => {
  it('removes the override bag for that context', () => {
    freshStore()
    const id = classId()
    const cid = useEditorStore.getState().addClassCondition(id, { kind: 'media', query: '(max-width: 860px)' })!
    useEditorStore.getState().removeClassContext(id, cid)
    expect(useEditorStore.getState().site!.styleRules[id].contextStyles).not.toHaveProperty(cid)
  })
})

describe('removeCondition', () => {
  it('drops the registry entry and clears it from every class', () => {
    freshStore()
    const id = classId()
    const cid = useEditorStore.getState().addClassCondition(id, { kind: 'media', query: '(max-width: 600px)' })!
    useEditorStore.getState().setClassContextStyles(id, cid, { color: 'red' })
    useEditorStore.getState().removeCondition(cid)
    const site = useEditorStore.getState().site!
    expect(site.conditions ?? []).toHaveLength(0)
    expect(site.styleRules[id].contextStyles).not.toHaveProperty(cid)
  })
})

describe('duplicateClass preserves context overrides', () => {
  it('deep-clones context bags (no shared references)', () => {
    freshStore()
    const id = classId()
    const cid = useEditorStore.getState().addClassCondition(id, { kind: 'media', query: '(max-width: 600px)' })!
    useEditorStore.getState().setClassContextStyles(id, cid, { color: 'red' })

    const copy = useEditorStore.getState().duplicateClass(id)!
    const copyBag = useEditorStore.getState().site!.styleRules[copy.id].contextStyles[cid]
    expect(copyBag).toMatchObject({ color: 'red' })

    // Mutating the copy must not touch the source (no shared reference).
    useEditorStore.getState().setClassContextStyles(copy.id, cid, { color: 'green' })
    expect(useEditorStore.getState().site!.styleRules[id].contextStyles[cid]).toMatchObject({ color: 'red' })
  })
})

describe('clearClassStyleProperties clears context overrides too', () => {
  it('"clear everywhere" removes the property from a condition context', () => {
    freshStore()
    const id = classId()
    useEditorStore.getState().updateClassStyles(id, { display: 'flex' })
    const cid = useEditorStore.getState().addClassCondition(id, { kind: 'media', query: '(max-width: 600px)' })!
    useEditorStore.getState().setClassContextStyles(id, cid, { display: 'grid' })

    useEditorStore.getState().clearClassStyleProperties(id, ['display'])

    const cls = useEditorStore.getState().site!.styleRules[id]
    expect(cls.styles).not.toHaveProperty('display')
    expect(cls.contextStyles[cid]).not.toHaveProperty('display')
  })
})
