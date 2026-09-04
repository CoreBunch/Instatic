/**
 * codeDockDrafts — the panels' unapplied buffers in the store: keyed by
 * document, bounded with the oldest abandoned first, removable.
 */
import { describe, expect, it } from 'bun:test'
import { MAX_CODE_DOCK_DRAFTS, withCodeDockDraft, type CodeDockDraft } from '@site/store/slices/codeDockDrafts'
import { useEditorStore } from '@site/store/store'

const css = (text: string): CodeDockDraft => ({ kind: 'css', text, syntaxErrorCount: 1 })

describe('withCodeDockDraft', () => {
  it('stores, replaces and removes drafts by key', () => {
    let drafts = withCodeDockDraft({}, 'a', css('one'))
    drafts = withCodeDockDraft(drafts, 'a', css('two'))
    expect(drafts).toEqual({ a: css('two') })
    expect(withCodeDockDraft(drafts, 'a', null)).toEqual({})
    expect(withCodeDockDraft(drafts, 'missing', null)).toEqual(drafts)
  })

  it('keeps at most the bound, dropping the oldest abandoned drafts first', () => {
    let drafts: Record<string, CodeDockDraft> = {}
    for (let i = 0; i < MAX_CODE_DOCK_DRAFTS + 2; i++) drafts = withCodeDockDraft(drafts, `k${i}`, css(String(i)))
    expect(Object.keys(drafts)).toHaveLength(MAX_CODE_DOCK_DRAFTS)
    expect(drafts.k0).toBeUndefined()
    expect(drafts.k1).toBeUndefined()
    expect(drafts[`k${MAX_CODE_DOCK_DRAFTS + 1}`]).toEqual(css(String(MAX_CODE_DOCK_DRAFTS + 1)))
  })
})

describe('setCodeDockDraft', () => {
  it('writes through the slice and ignores removing an absent key', () => {
    const before = useEditorStore.getState().codeDockDrafts
    useEditorStore.getState().setCodeDockDraft('nope', null)
    expect(useEditorStore.getState().codeDockDrafts).toBe(before)
    useEditorStore.getState().setCodeDockDraft('x', css('x'))
    expect(useEditorStore.getState().codeDockDrafts.x).toEqual(css('x'))
    useEditorStore.getState().setCodeDockDraft('x', null)
    expect(useEditorStore.getState().codeDockDrafts.x).toBeUndefined()
  })
})
