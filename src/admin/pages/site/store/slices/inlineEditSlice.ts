/**
 * Inline text edit slice — ephemeral canvas UI state for the double-click
 * inline text editor.
 * Spec: docs/superpowers/specs/2026-06-10-inline-text-editing-design.md
 *
 * The session is UI-only state (never persisted, never itself part of undo
 * history). Live commits route through `updateNodeProps`, whose single-field
 * patches coalesce under `props:<nodeId>:<prop>` (see `coalesceKeyForPatch`
 * in slices/site/nodeActions.ts) — the whole typing burst is ONE undo entry,
 * which is what lets `cancelInlineEdit` revert with a single `undo()`.
 *
 * Burst isolation: `startInlineEdit` and `endInlineEdit` both reset
 * `_historyCoalesceKey`, so the inline burst can never fold into a
 * Properties-panel typing burst for the same prop (or vice versa) — Escape
 * must revert exactly the inline session, nothing more.
 */
import { registry } from '@core/module-engine'
import type { EditorStoreSliceCreator } from '@site/store/types'
import { getActiveTree } from './selectionSlice'

export interface ActiveInlineEdit {
  nodeId: string
  /** The single string prop being edited (from ModuleDefinition.inlineTextEdit). */
  prop: string
  /** The breakpoint frame the user double-clicked in — owns the overlay. */
  breakpointId: string
  multiline: boolean
  /** Prop value when the session started; cancel restores it via one undo(). */
  initialValue: string
  /** True once a keystroke produced a REAL history entry (a burst exists). */
  committed: boolean
}

export interface InlineEditSlice {
  activeInlineEdit: ActiveInlineEdit | null
  /**
   * Start a session for `nodeId` in `breakpointId`'s frame. No-ops when the
   * module doesn't declare `inlineTextEdit`, the node has children
   * (base.link renders children instead of `text`), the prop is dynamically
   * bound, or the stored value isn't a string (corrupt tree → console.warn).
   */
  startInlineEdit: (nodeId: string, breakpointId: string) => void
  /** Live per-keystroke commit — one coalesced undo entry per session. */
  applyInlineEditValue: (value: string) => void
  /** Commit + close. Keystrokes already landed live; this ends session + burst. */
  endInlineEdit: () => void
  /** Revert + close: one undo() iff the session committed anything. */
  cancelInlineEdit: () => void
}

// Contribute this slice's fields to the combined `EditorStore` type via TS
// module augmentation. See `../types.ts` for why we use this pattern.
declare module '@site/store/types' {
  interface EditorStore extends InlineEditSlice {}
}

export const createInlineEditSlice: EditorStoreSliceCreator<InlineEditSlice> = (set, get) => ({
  activeInlineEdit: null,

  startInlineEdit: (nodeId, breakpointId) => {
    const state = get()
    const node = getActiveTree(state)?.nodes[nodeId]
    if (!node) return
    const def = registry.get(node.moduleId)
    const spec = def?.inlineTextEdit
    if (!spec) return
    // Sandboxed (untrusted plugin) modules render in a ModuleSandboxFrame, which
    // never receives the inlineEdit binding — so there'd be no contentEditable
    // element to focus/commit and the session would be stuck. Mirror
    // NodeRenderer's `shouldRenderSandbox` check and never start for them.
    if (def?.editorRuntime?.sandbox && !def.trusted) return
    // A node rendering children doesn't render its text prop (base.link).
    if (node.children.length > 0) return
    // A dynamically-bound prop isn't literal-editable — the binding would
    // overwrite every keystroke in the canvas preview.
    if (node.dynamicBindings?.[spec.prop]) return
    const value = node.props[spec.prop]
    if (typeof value !== 'string') {
      console.warn(
        `[canvas] inline edit aborted: prop "${spec.prop}" on node "${nodeId}" is not a string`,
      )
      return
    }
    set((s) => {
      s.activeInlineEdit = {
        nodeId,
        prop: spec.prop,
        breakpointId,
        multiline: spec.multiline ?? false,
        initialValue: value,
        committed: false,
      }
      // Isolate the session's burst from any in-flight coalescing burst for
      // the same key (e.g. Properties-panel typing on the same prop).
      s._historyCoalesceKey = null
    })
  },

  applyInlineEditValue: (value) => {
    const state = get()
    const session = state.activeInlineEdit
    if (!session) return
    const node = getActiveTree(state)?.nodes[session.nodeId]
    if (!node) return
    // `committed` flips only on a REAL change — updateNodeProps no-ops equal
    // values (recordPatchChanges), and cancel must not undo() unless this
    // session actually pushed a history entry.
    const changed = !Object.is(node.props[session.prop], value)
    state.updateNodeProps(session.nodeId, { [session.prop]: value })
    if (changed && !session.committed) {
      set((s) => {
        if (s.activeInlineEdit) s.activeInlineEdit.committed = true
      })
    }
  },

  endInlineEdit: () => {
    if (!get().activeInlineEdit) return
    set((s) => {
      s.activeInlineEdit = null
      // End the burst: later edits of the same prop get a fresh undo entry.
      s._historyCoalesceKey = null
    })
  },

  cancelInlineEdit: () => {
    const session = get().activeInlineEdit
    if (!session) return
    // The whole session is one coalesced entry — a single undo() restores
    // the pre-session value. undo() also resets _historyCoalesceKey.
    if (session.committed) get().undo()
    set((s) => {
      s.activeInlineEdit = null
      s._historyCoalesceKey = null
    })
  },
})
