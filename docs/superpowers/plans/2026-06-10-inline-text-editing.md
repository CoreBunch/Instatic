# Inline Text Editing Implementation Plan

> **⚠️ SUPERSEDED — historical record.** This plan implemented the parent-document **overlay** approach (a `<textarea>`/`<input>` floated over the node, typography mirrored from the iframe, doubled text hidden). That approach was later replaced by editing the **real node element in place** via `contentEditable` for 100% fidelity. Everything below describing `InlineTextEditOverlay`, `mirrorInlineEditTypography`, `ParentDocumentSiteFontsInjector`, the `data-instatic-inline-editing` hide rule, and `white-space`-dependent newlines no longer reflects the code. The module contract, the `inlineEditSlice` session, and the live-commit/undo model are still accurate. For current behaviour see the superseding note in `docs/superpowers/specs/2026-06-10-inline-text-editing-design.md` and `docs/features/canvas-iframe-per-frame.md` → "Inline text editing".

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Double-click a text-bearing canvas node (`base.text`, `base.button`, childless `base.link`) and edit its text in a parent-document overlay positioned over the node inside the breakpoint iframe, with live per-keystroke commit, one undo entry per session, and Escape-to-cancel.

**Architecture:** A new optional `ModuleDefinition.inlineTextEdit` contract drives a new editor-store `inlineEditSlice` session (`activeInlineEdit`); a new `InlineTextEditOverlay` component (portal + RAF pattern copied from `BreakpointSelectionOverlay`) renders a real `<textarea>`/`<input>` in the parent document over the node's rect via `measureCanvasElementRect`, mirroring typography from the iframe's `getComputedStyle`. Live commits route through the existing `updateNodeProps` coalescing (`props:<nodeId>:<prop>`), and the edited node's own text is hidden in the session's frame only via a `data-instatic-inline-editing` attribute + a `CANVAS_CHROME_CSS` rule.

**Tech Stack:** React 19 (React Compiler — no useMemo/useCallback/memo in new code), Zustand + zustand-mutative, CSS Modules with `var(--*)` tokens, bun test (happy-dom + @testing-library/react), TypeScript.

**Baseline:** fresh worktree off main HEAD `0503316e`. All file/line references below are against that commit. Spec source of truth: `docs/superpowers/specs/2026-06-10-inline-text-editing-design.md` (committed in Task 1).

**Design decisions resolved from code (spec open questions):**
- `base.text` does NOT render newlines: `render()` (src/modules/base/text/index.ts:93-102) interpolates raw text into `<p>…</p>` where whitespace collapses, and no module or canvas CSS sets `white-space`. Therefore **plain Enter commits + closes in BOTH modes**; Shift+Enter in multiline falls through to the native newline (parity with the Properties-panel textarea, useful with author `white-space: pre-wrap` CSS); Cmd/Ctrl+Enter also commits.
- The hide-doubled-text rule uses `-webkit-text-fill-color: transparent` instead of `color: transparent` because the overlay mirrors `getComputedStyle(el).color` for the field text on every RAF tick — `color: transparent` would feed transparent back into the mirror and make the typed text invisible.
- The canvas-injected CSS mechanism is `CANVAS_CHROME_CSS` in `IframeFrameSurface.tsx` (applied only to design frames via `applyIframeBodyReset`, already `!important`-based by documented necessity) — exactly where the rule must live so live-mode frames are unaffected.
- "Link-with-children does not start" is implemented as the generic rule `node.children.length > 0 → no-op` (no per-module branches in canvas code, per spec). Dynamically-bound props (`node.dynamicBindings?.[prop]`) also no-op — the binding would overwrite every keystroke in the preview.
- Inline editing is design-canvas-only in v1: `CanvasRoot.onNodeDoubleClick` guards on `isLive` so a live-mode double-click stays a no-op (the overlay only mounts in `BreakpointFrame`).

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `docs/superpowers/specs/2026-06-10-inline-text-editing-design.md` | Create | Approved spec, copied into the repo (Task 1) |
| `src/core/module-engine/types.ts` | Modify (~line 213, after `canHaveChildren`) | `inlineTextEdit?: { prop: string; multiline?: boolean }` on `ModuleDefinition` |
| `src/modules/base/text/index.ts` | Modify (~line 52) | Declare `inlineTextEdit: { prop: 'text', multiline: true }` |
| `src/modules/base/button/index.ts` | Modify (~line 39) | Declare `inlineTextEdit: { prop: 'label' }` |
| `src/modules/base/link/index.ts` | Modify (~line 38) | Declare `inlineTextEdit: { prop: 'text' }` |
| `src/__tests__/base-modules.test.ts` | Modify (append describe) | Module declaration conformance tests |
| `src/admin/pages/site/store/slices/inlineEditSlice.ts` | Create | `activeInlineEdit` session state + start/apply/end/cancel actions |
| `src/admin/pages/site/store/slices/selectionSlice.ts` | Modify (lines 191-223, 350) | Export `getActiveTree`; force-close session in `clearCanvasSelectionDraft` / `pruneCanvasSelectionDraft` |
| `src/admin/pages/site/store/store.ts` | Modify (lines 17, 26, 70-71) | Register `createInlineEditSlice` |
| `src/__tests__/architecture/centralized-site-mutation-history.test.ts` | Modify (SLICE_FILES, line 14-23) | Add `inlineEditSlice.ts` to the no-direct-pushHistory gate |
| `src/__tests__/editor-store/inlineEditSlice.test.ts` | Create | Session lifecycle, coalescing, cancel, force-close store tests |
| `src/admin/pages/site/canvas/canvasOverlayGeometry.ts` | Modify (append) | `scaleCssLength` + `mirrorInlineEditTypography` |
| `src/__tests__/canvas/canvasOverlayGeometry.test.ts` | Create | Pure-function tests for `scaleCssLength` |
| `src/admin/pages/site/canvas/InlineTextEditOverlay.tsx` | Create | The parent-doc overlay editor (portal + RAF) |
| `src/admin/pages/site/canvas/InlineTextEditOverlay.module.css` | Create | Field chrome: transparent bg, no border, `--canvas-selection-ring` focus ring |
| `src/admin/pages/site/canvas/BreakpointFrame.tsx` | Modify (imports + after line 260) | Mount `InlineTextEditOverlay` per design frame |
| `src/__tests__/canvas/inlineTextEditOverlay.test.tsx` | Create | Overlay component tests (gating, variants, Enter/Escape/blur, unmount) |
| `src/admin/pages/site/canvas/CanvasContexts.ts` | Modify (line 8, 15) | `onNodeDoubleClick` gains optional `breakpointId` |
| `src/admin/pages/site/canvas/NodeRenderer.tsx` | Modify (lines ~61, ~192, 233-249) | `isInlineEditing` subscription → `data-instatic-inline-editing`; pass `breakpointId` on double-click |
| `src/core/module-engine/types.ts` | Modify (NodeWrapperProps, ~line 115) | `'data-instatic-inline-editing'?: 'true'` |
| `src/admin/pages/site/canvas/CanvasRoot.tsx` | Modify (lines ~111, 287-304) | Replace no-op double-click with `startInlineEdit` |
| `src/admin/pages/site/canvas/IframeFrameSurface.tsx` | Modify (CANVAS_CHROME_CSS, lines 650-661) | Hide-doubled-text rule |
| `src/__tests__/canvas/inlineTextEditingWiring.test.ts` | Create | Source-assertion wiring tests (existing canvasNotch.test.ts convention) |
| `docs/features/canvas-iframe-per-frame.md` | Modify (new section; delete lines 160-166 limitation) | Document the implemented design |
| `docs/editor.md` | Modify (slice table ~line 329; canvas section ~line 410; key files table ~line 464) | Slice row, canvas behaviour paragraph, key-file row |

---

### Task 1: Commit the approved spec into the repo

**Files:**
- Create: `docs/superpowers/specs/2026-06-10-inline-text-editing-design.md` (content from `/tmp/instatic-specs/2026-06-10-inline-text-editing-design.md`)

- [ ] Copy the spec into the repo (the `docs/superpowers/specs/` directory already exists):

```bash
cp /tmp/instatic-specs/2026-06-10-inline-text-editing-design.md docs/superpowers/specs/2026-06-10-inline-text-editing-design.md
```

- [ ] Verify the copy landed and matches the source:

```bash
diff /tmp/instatic-specs/2026-06-10-inline-text-editing-design.md docs/superpowers/specs/2026-06-10-inline-text-editing-design.md && head -4 docs/superpowers/specs/2026-06-10-inline-text-editing-design.md
```

Expected output: no diff, and the header `# Inline text editing on the canvas (double-click to edit) — Design` / `Status: approved`.

- [ ] Commit:

```bash
git add docs/superpowers/specs/2026-06-10-inline-text-editing-design.md
git commit -m "$(cat <<'EOF'
docs: add approved inline text editing design spec

Approach 1A — parent-doc overlay editor over the breakpoint iframe.
Source of truth for the inline-text-editing implementation tasks.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Module contract — `inlineTextEdit` on `ModuleDefinition` + declarations

**Files:**
- Modify: `src/core/module-engine/types.ts` (insert after `canHaveChildren: boolean` — line 213)
- Modify: `src/modules/base/text/index.ts` (insert after `canHaveChildren: false,` — line 52)
- Modify: `src/modules/base/button/index.ts` (insert after `canHaveChildren: false,` — line 39)
- Modify: `src/modules/base/link/index.ts` (insert after `canHaveChildren: true,` — line 38)
- Test: `src/__tests__/base-modules.test.ts` (append a describe block at end of file)

- [ ] Write the failing test. Append to the END of `src/__tests__/base-modules.test.ts` (the file already imports `TextModule`, `ButtonModule`, `LinkModule` at lines 31-37):

```ts
// ---------------------------------------------------------------------------
// Inline text edit declarations (docs/superpowers/specs/
// 2026-06-10-inline-text-editing-design.md) — the canvas resolves these
// generically; the declaration IS the feature's per-module surface.
// ---------------------------------------------------------------------------

describe('inline text edit declarations', () => {
  it('base.text edits the multiline `text` prop', () => {
    expect(TextModule.inlineTextEdit).toEqual({ prop: 'text', multiline: true })
  })

  it('base.button edits the single-line `label` prop', () => {
    expect(ButtonModule.inlineTextEdit).toEqual({ prop: 'label' })
  })

  it('base.link edits the single-line `text` prop (childless render path)', () => {
    expect(LinkModule.inlineTextEdit).toEqual({ prop: 'text' })
  })

  it('every declared prop exists in the module schema with a string default', () => {
    expect(Object.keys(TextModule.schema)).toContain('text')
    expect(typeof TextModule.defaults.text).toBe('string')
    expect(Object.keys(ButtonModule.schema)).toContain('label')
    expect(typeof ButtonModule.defaults.label).toBe('string')
    expect(Object.keys(LinkModule.schema)).toContain('text')
    expect(typeof LinkModule.defaults.text).toBe('string')
  })
})
```

- [ ] Run it and expect failure:

```bash
bun test src/__tests__/base-modules.test.ts -t 'inline text edit declarations'
```

Expected: 3 failures — `Expected: { prop: "text", multiline: true } / Received: undefined` (and the button/link analogues). The string-default test passes already.

- [ ] Add the contract to `src/core/module-engine/types.ts`. Insert after the `canHaveChildren: boolean` member (line 213), before the `publishBehavior` doc block:

```ts
  /**
   * Opt-in canvas inline text editing (double-click a node on the canvas).
   * `prop` names the single string prop the overlay edits; `multiline: true`
   * renders a `<textarea>` instead of an `<input>`. Modules without this
   * field keep the no-op double-click. The canvas resolves the contract
   * generically — no per-module branches (a node with children never starts
   * a session, which is how `base.link`'s children-over-text render rule is
   * honoured). See docs/features/canvas-iframe-per-frame.md → "Inline text
   * editing (parent-doc overlay)".
   */
  inlineTextEdit?: { prop: string; multiline?: boolean }

```

- [ ] Declare it on the three modules. In `src/modules/base/text/index.ts` insert after line 52 (`canHaveChildren: false,`):

```ts
  inlineTextEdit: { prop: 'text', multiline: true },
```

In `src/modules/base/button/index.ts` insert after line 39 (`canHaveChildren: false,`):

```ts
  inlineTextEdit: { prop: 'label' },
```

In `src/modules/base/link/index.ts` insert after line 38 (`canHaveChildren: true,`):

```ts
  // Inline-editable only while childless — the canvas's generic
  // children-guard mirrors linkUsesChildren() in render().
  inlineTextEdit: { prop: 'text' },
```

- [ ] Run and expect pass:

```bash
bun test src/__tests__/base-modules.test.ts
```

Expected: all tests pass (including the pre-existing conformance suite).

- [ ] Commit:

```bash
git add src/core/module-engine/types.ts src/modules/base/text/index.ts src/modules/base/button/index.ts src/modules/base/link/index.ts src/__tests__/base-modules.test.ts
git commit -m "$(cat <<'EOF'
feat(module-engine): add inlineTextEdit contract, declare on text/button/link

Optional ModuleDefinition.inlineTextEdit { prop, multiline? } is the
extension point for canvas double-click inline editing — no per-module
branches in canvas code.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Editor-store inline edit session slice

**Files:**
- Create: `src/admin/pages/site/store/slices/inlineEditSlice.ts`
- Modify: `src/admin/pages/site/store/slices/selectionSlice.ts` (line 350: export `getActiveTree`)
- Modify: `src/admin/pages/site/store/store.ts` (line 17 imports; line 26 comment; line 70 spread)
- Modify: `src/__tests__/architecture/centralized-site-mutation-history.test.ts` (SLICE_FILES array, lines 14-23)
- Test: `src/__tests__/editor-store/inlineEditSlice.test.ts`

- [ ] Write the failing test. Create `src/__tests__/editor-store/inlineEditSlice.test.ts`:

```ts
/**
 * Inline text edit slice tests — session lifecycle, live-commit coalescing
 * (one undo entry per burst), Escape-cancel via single undo, and start
 * guards (non-editable modules, link-with-children, non-string props).
 * Spec: docs/superpowers/specs/2026-06-10-inline-text-editing-design.md
 */
import { describe, it, expect, beforeEach, spyOn } from 'bun:test'
import { useEditorStore } from '@site/store/store'
// Side-effect imports: register the modules under test into the global registry.
import '@modules/base/text'
import '@modules/base/button'
import '@modules/base/link'
import '@modules/base/container'

function setupSiteWithTextNode(text = 'Hello'): { nodeId: string; rootId: string; pageId: string } {
  const store = useEditorStore.getState()
  const site = store.createSite('Inline Edit Test Site')
  const pageId = site.pages[0].id
  const rootId = site.pages[0].rootNodeId
  const nodeId = useEditorStore.getState().insertNode('base.text', { text }, rootId)
  return { nodeId, rootId, pageId }
}

function nodeText(nodeId: string): unknown {
  const site = useEditorStore.getState().site!
  for (const page of site.pages) {
    if (page.nodes[nodeId]) return page.nodes[nodeId].props.text
  }
  return undefined
}

beforeEach(() => {
  useEditorStore.setState({
    site: null,
    activePageId: null,
    activeDocument: null,
    activeInlineEdit: null,
    _historyPast: [],
    _historyFuture: [],
    _historyCoalesceKey: null,
    canUndo: false,
    canRedo: false,
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
    hasUnsavedChanges: false,
  })
})

describe('startInlineEdit', () => {
  it('opens a multiline session for base.text on the text prop', () => {
    const { nodeId } = setupSiteWithTextNode()
    useEditorStore.getState().startInlineEdit(nodeId, 'bp-desktop')
    expect(useEditorStore.getState().activeInlineEdit).toEqual({
      nodeId,
      prop: 'text',
      breakpointId: 'bp-desktop',
      multiline: true,
      initialValue: 'Hello',
      committed: false,
    })
  })

  it('opens a single-line session for base.button on the label prop', () => {
    const store = useEditorStore.getState()
    const site = store.createSite('Inline Edit Test Site')
    const rootId = site.pages[0].rootNodeId
    const buttonId = useEditorStore.getState().insertNode('base.button', { label: 'Go' }, rootId)
    useEditorStore.getState().startInlineEdit(buttonId, 'bp-mobile')
    const session = useEditorStore.getState().activeInlineEdit
    expect(session?.prop).toBe('label')
    expect(session?.multiline).toBe(false)
    expect(session?.initialValue).toBe('Go')
  })

  it('opens a session for a childless base.link on the text prop', () => {
    const store = useEditorStore.getState()
    const site = store.createSite('Inline Edit Test Site')
    const rootId = site.pages[0].rootNodeId
    const linkId = useEditorStore.getState().insertNode('base.link', {}, rootId)
    useEditorStore.getState().startInlineEdit(linkId, 'bp-desktop')
    expect(useEditorStore.getState().activeInlineEdit?.prop).toBe('text')
  })

  it('no-ops for modules without inlineTextEdit', () => {
    const store = useEditorStore.getState()
    const site = store.createSite('Inline Edit Test Site')
    const rootId = site.pages[0].rootNodeId
    const containerId = useEditorStore.getState().insertNode('base.container', {}, rootId)
    useEditorStore.getState().startInlineEdit(containerId, 'bp-desktop')
    expect(useEditorStore.getState().activeInlineEdit).toBeNull()
  })

  it('no-ops for base.link with children (text renders only childless)', () => {
    const store = useEditorStore.getState()
    const site = store.createSite('Inline Edit Test Site')
    const rootId = site.pages[0].rootNodeId
    const linkId = useEditorStore.getState().insertNode('base.link', {}, rootId)
    useEditorStore.getState().insertNode('base.text', {}, linkId)
    useEditorStore.getState().startInlineEdit(linkId, 'bp-desktop')
    expect(useEditorStore.getState().activeInlineEdit).toBeNull()
  })

  it('no-ops with a [canvas] warning when the stored prop is not a string', () => {
    const { nodeId } = setupSiteWithTextNode()
    useEditorStore.getState().updateNodeProps(nodeId, { text: 42 })
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    useEditorStore.getState().startInlineEdit(nodeId, 'bp-desktop')
    expect(useEditorStore.getState().activeInlineEdit).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toStartWith('[canvas]')
    warn.mockRestore()
  })

  it('no-ops for unknown node ids', () => {
    setupSiteWithTextNode()
    useEditorStore.getState().startInlineEdit('does-not-exist', 'bp-desktop')
    expect(useEditorStore.getState().activeInlineEdit).toBeNull()
  })
})

describe('applyInlineEditValue — live commit, one undo entry per burst', () => {
  it('commits every keystroke live and coalesces the burst into ONE history entry', () => {
    const { nodeId } = setupSiteWithTextNode()
    useEditorStore.getState().startInlineEdit(nodeId, 'bp')
    const entriesBefore = useEditorStore.getState()._historyPast.length
    useEditorStore.getState().applyInlineEditValue('HelloW')
    useEditorStore.getState().applyInlineEditValue('HelloWo')
    useEditorStore.getState().applyInlineEditValue('HelloWorld')
    const state = useEditorStore.getState()
    expect(nodeText(nodeId)).toBe('HelloWorld')
    expect(state._historyPast.length).toBe(entriesBefore + 1)
    expect(state.activeInlineEdit?.committed).toBe(true)
  })

  it('a single undo() reverts the whole burst to the initial value', () => {
    const { nodeId } = setupSiteWithTextNode()
    useEditorStore.getState().startInlineEdit(nodeId, 'bp')
    useEditorStore.getState().applyInlineEditValue('A')
    useEditorStore.getState().applyInlineEditValue('AB')
    useEditorStore.getState().undo()
    expect(nodeText(nodeId)).toBe('Hello')
  })

  it('does not flip committed when the applied value equals the stored value', () => {
    const { nodeId } = setupSiteWithTextNode()
    useEditorStore.getState().startInlineEdit(nodeId, 'bp')
    const entriesBefore = useEditorStore.getState()._historyPast.length
    useEditorStore.getState().applyInlineEditValue('Hello')
    const state = useEditorStore.getState()
    expect(state.activeInlineEdit?.committed).toBe(false)
    expect(state._historyPast.length).toBe(entriesBefore)
  })

  it('isolates the session burst from a prior Properties-panel burst on the same prop', () => {
    const { nodeId } = setupSiteWithTextNode()
    // Simulate panel typing: same coalesce key the inline session will use.
    useEditorStore.getState().updateNodeProps(nodeId, { text: 'PanelTyped' })
    const entriesBefore = useEditorStore.getState()._historyPast.length
    useEditorStore.getState().startInlineEdit(nodeId, 'bp')
    useEditorStore.getState().applyInlineEditValue('PanelTypedX')
    expect(useEditorStore.getState()._historyPast.length).toBe(entriesBefore + 1)
    // Escape reverts ONLY the inline burst, not the panel typing.
    useEditorStore.getState().cancelInlineEdit()
    expect(nodeText(nodeId)).toBe('PanelTyped')
  })

  it('no-ops without an active session', () => {
    const { nodeId } = setupSiteWithTextNode()
    useEditorStore.getState().applyInlineEditValue('ignored')
    expect(nodeText(nodeId)).toBe('Hello')
  })
})

describe('endInlineEdit', () => {
  it('closes the session and ends the burst so later edits undo separately', () => {
    const { nodeId } = setupSiteWithTextNode()
    useEditorStore.getState().startInlineEdit(nodeId, 'bp')
    useEditorStore.getState().applyInlineEditValue('HelloA')
    const entriesAfterBurst = useEditorStore.getState()._historyPast.length
    useEditorStore.getState().endInlineEdit()
    expect(useEditorStore.getState().activeInlineEdit).toBeNull()
    expect(nodeText(nodeId)).toBe('HelloA')
    // A later edit of the SAME prop starts a fresh undo entry.
    useEditorStore.getState().updateNodeProps(nodeId, { text: 'HelloB' })
    expect(useEditorStore.getState()._historyPast.length).toBe(entriesAfterBurst + 1)
  })
})

describe('cancelInlineEdit', () => {
  it('reverts a committed session with exactly one undo', () => {
    const { nodeId } = setupSiteWithTextNode()
    useEditorStore.getState().startInlineEdit(nodeId, 'bp')
    useEditorStore.getState().applyInlineEditValue('Mangled')
    const entriesBefore = useEditorStore.getState()._historyPast.length
    useEditorStore.getState().cancelInlineEdit()
    const state = useEditorStore.getState()
    expect(state.activeInlineEdit).toBeNull()
    expect(nodeText(nodeId)).toBe('Hello')
    expect(state._historyPast.length).toBe(entriesBefore - 1)
  })

  it('does NOT undo for an uncommitted session', () => {
    const { nodeId } = setupSiteWithTextNode()
    useEditorStore.getState().startInlineEdit(nodeId, 'bp')
    const entriesBefore = useEditorStore.getState()._historyPast.length
    useEditorStore.getState().cancelInlineEdit()
    const state = useEditorStore.getState()
    expect(state.activeInlineEdit).toBeNull()
    expect(state._historyPast.length).toBe(entriesBefore)
    expect(nodeText(nodeId)).toBe('Hello')
  })
})
```

- [ ] Run it and expect failure:

```bash
bun test src/__tests__/editor-store/inlineEditSlice.test.ts
```

Expected: every test fails with `TypeError: useEditorStore.getState().startInlineEdit is not a function` (the slice doesn't exist yet).

- [ ] Export the active-tree resolver. In `src/admin/pages/site/store/slices/selectionSlice.ts` line 350, change:

```ts
function getActiveTree(state: EditorStore): NodeTree<PageNode> | null {
```

to:

```ts
export function getActiveTree(state: EditorStore): NodeTree<PageNode> | null {
```

and extend the doc comment above it (lines 344-349) by appending one line:

```ts
 * Also consumed by `inlineEditSlice` (same no-cycle rationale).
```

- [ ] Create `src/admin/pages/site/store/slices/inlineEditSlice.ts`:

```ts
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
    const spec = registry.get(node.moduleId)?.inlineTextEdit
    if (!spec) return
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
```

- [ ] Register the slice in `src/admin/pages/site/store/store.ts`. Add to the imports (after line 17, `createClipboardSlice`):

```ts
import { createInlineEditSlice } from './slices/inlineEditSlice'
```

In the composition comment (line 26), change `Composed of 11 slices` to `Composed of 12 slices` and add to the slice list:

```ts
 *   - inlineEditSlice:     canvas inline text edit session (double-click to edit)
```

Add the spread after `...createClipboardSlice(...args),` (line 70):

```ts
        ...createInlineEditSlice(...args),
```

- [ ] Keep the architecture gate in lock-step. In `src/__tests__/architecture/centralized-site-mutation-history.test.ts`, add to `SLICE_FILES` (lines 14-23):

```ts
  'src/admin/pages/site/store/slices/inlineEditSlice.ts',
```

- [ ] Run and expect pass:

```bash
bun test src/__tests__/editor-store/inlineEditSlice.test.ts src/__tests__/architecture/centralized-site-mutation-history.test.ts src/__tests__/editor-store/undo-redo.test.ts
```

Expected: all pass. (undo-redo.test.ts is included to prove the coalesce-key reset doesn't disturb existing history semantics.)

- [ ] Commit:

```bash
git add src/admin/pages/site/store/slices/inlineEditSlice.ts src/admin/pages/site/store/slices/selectionSlice.ts src/admin/pages/site/store/store.ts src/__tests__/architecture/centralized-site-mutation-history.test.ts src/__tests__/editor-store/inlineEditSlice.test.ts
git commit -m "$(cat <<'EOF'
feat(editor-store): add inline text edit session slice with coalesced live commit

activeInlineEdit + startInlineEdit/applyInlineEditValue/endInlineEdit/
cancelInlineEdit. Live commits ride updateNodeProps' props:<nodeId>:<prop>
coalescing so a whole session is one undo entry; start/end reset
_historyCoalesceKey to isolate the burst; cancel undoes once iff committed.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Force-close on node deletion and document switch

**Files:**
- Modify: `src/admin/pages/site/store/slices/selectionSlice.ts` (`clearCanvasSelectionDraft` lines 191-197; `pruneCanvasSelectionDraft` lines 210-223)
- Test: `src/__tests__/editor-store/inlineEditSlice.test.ts` (append a describe block)

- [ ] Write the failing tests. Append to `src/__tests__/editor-store/inlineEditSlice.test.ts`:

```ts
describe('force-close', () => {
  it('clears the session when the edited node is deleted', () => {
    const { nodeId } = setupSiteWithTextNode()
    useEditorStore.getState().startInlineEdit(nodeId, 'bp')
    useEditorStore.getState().deleteNode(nodeId)
    expect(useEditorStore.getState().activeInlineEdit).toBeNull()
  })

  it('clears the session when the edited node is swept with a deleted ancestor', () => {
    const store = useEditorStore.getState()
    const site = store.createSite('Inline Edit Test Site')
    const rootId = site.pages[0].rootNodeId
    const containerId = useEditorStore.getState().insertNode('base.container', {}, rootId)
    const textId = useEditorStore.getState().insertNode('base.text', { text: 'Hi' }, containerId)
    useEditorStore.getState().startInlineEdit(textId, 'bp')
    expect(useEditorStore.getState().activeInlineEdit).not.toBeNull()
    useEditorStore.getState().deleteNode(containerId)
    expect(useEditorStore.getState().activeInlineEdit).toBeNull()
  })

  it('clears the session on page switch', () => {
    const { nodeId, pageId } = setupSiteWithTextNode()
    // addPage activates the new page — hop back before starting the session.
    const pageB = useEditorStore.getState().addPage('Second', 'second')
    useEditorStore.getState().openPageInCanvas(pageId)
    useEditorStore.getState().startInlineEdit(nodeId, 'bp')
    expect(useEditorStore.getState().activeInlineEdit).not.toBeNull()
    useEditorStore.getState().openPageInCanvas(pageB.id)
    expect(useEditorStore.getState().activeInlineEdit).toBeNull()
  })

  it('clears the session on active-document switch', () => {
    const { nodeId } = setupSiteWithTextNode()
    useEditorStore.getState().startInlineEdit(nodeId, 'bp')
    useEditorStore.getState().setActiveDocument({ kind: 'visualComponent', vcId: 'vc-x' })
    expect(useEditorStore.getState().activeInlineEdit).toBeNull()
  })
})
```

- [ ] Run and expect failure:

```bash
bun test src/__tests__/editor-store/inlineEditSlice.test.ts -t 'force-close'
```

Expected: all 4 fail — `activeInlineEdit` is still the session object (received not null).

- [ ] Implement in `src/admin/pages/site/store/slices/selectionSlice.ts`. In `clearCanvasSelectionDraft` (lines 191-197), add one line inside the function body:

```ts
export function clearCanvasSelectionDraft(state: EditorStore): void {
  state.selectedNodeIds = []
  state.selectedNodeId = null
  state.hoveredNodeId = null
  state.hoveredBreakpointId = null
  state.activeClassId = null
  // A document/page switch invalidates any inline text-edit session — the
  // node it points at is no longer on the canvas. Live keystrokes already
  // committed; clearing here is the spec's "force-close without committing".
  state.activeInlineEdit = null
}
```

In `pruneCanvasSelectionDraft` (lines 210-223), add the inline-edit prune BEFORE the surviving-length early return (it must run even when the deleted node wasn't selected):

```ts
export function pruneCanvasSelectionDraft(state: EditorStore): void {
  const tree = getActiveTree(state)
  // Inline edit prunes by tree-membership too — the edited node may be a
  // descendant swept away with a deleted subtree, and it may not be part of
  // the selection at all, so this must run before the early return below.
  if (state.activeInlineEdit && !tree?.nodes[state.activeInlineEdit.nodeId]) {
    state.activeInlineEdit = null
  }
  const surviving = tree
    ? state.selectedNodeIds.filter((id) => Boolean(tree.nodes[id]))
    : []
  if (surviving.length === state.selectedNodeIds.length) return
  ...   // (rest of the function unchanged — lines 215-223)
}
```

(Only the comment + 3-line guard are new; keep the existing body verbatim.)

- [ ] Run and expect pass:

```bash
bun test src/__tests__/editor-store/inlineEditSlice.test.ts src/__tests__/editor-store/selectionSlice.test.ts src/__tests__/editor-store/multiSelect.test.ts
```

Expected: all pass (selectionSlice/multiSelect prove the helpers' existing contracts are untouched).

- [ ] Commit:

```bash
git add src/admin/pages/site/store/slices/selectionSlice.ts src/__tests__/editor-store/inlineEditSlice.test.ts
git commit -m "$(cat <<'EOF'
feat(editor-store): force-close inline edit sessions on deletion and doc switch

clearCanvasSelectionDraft (page/VC/document switches) and
pruneCanvasSelectionDraft (node deletion, incl. swept descendants) now
clear activeInlineEdit, funnelling every stale-session path through the
same helpers the selection already uses.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Overlay geometry — typography mirroring helpers

**Files:**
- Modify: `src/admin/pages/site/canvas/canvasOverlayGeometry.ts` (append after `measureCanvasElementRect`, line 42)
- Test: `src/__tests__/canvas/canvasOverlayGeometry.test.ts`

- [ ] Write the failing test. Create `src/__tests__/canvas/canvasOverlayGeometry.test.ts`:

```ts
/**
 * canvasOverlayGeometry — pure-function tests for the inline-edit typography
 * scaling. (measureCanvasElementRect is exercised indirectly by the existing
 * overlay integration paths; the scaler is the new, directly-testable logic.)
 */
import { describe, it, expect } from 'bun:test'
import { scaleCssLength } from '@site/canvas/canvasOverlayGeometry'

describe('scaleCssLength', () => {
  it('scales px lengths by the iframe scale factor', () => {
    expect(scaleCssLength('32px', 0.5)).toBe('16px')
  })

  it('passes keywords through untouched', () => {
    expect(scaleCssLength('normal', 0.5)).toBe('normal')
  })

  it('handles fractional and negative px values', () => {
    expect(scaleCssLength('1.5px', 2)).toBe('3px')
    expect(scaleCssLength('-0.5px', 2)).toBe('-1px')
  })

  it('leaves non-px values untouched (unitless line-height, em)', () => {
    expect(scaleCssLength('1.4', 0.5)).toBe('1.4')
    expect(scaleCssLength('0.02em', 0.5)).toBe('0.02em')
  })
})
```

- [ ] Run and expect failure:

```bash
bun test src/__tests__/canvas/canvasOverlayGeometry.test.ts
```

Expected: `SyntaxError`/export error — `scaleCssLength` is not exported from `canvasOverlayGeometry`.

- [ ] Append to `src/admin/pages/site/canvas/canvasOverlayGeometry.ts` (after line 42):

```ts
/** Typography lengths that must shrink/grow with the canvas zoom. */
const SCALED_TYPOGRAPHY_PROPS = ['font-size', 'line-height', 'letter-spacing'] as const

/** Typography that transfers verbatim from the measured element. */
const COPIED_TYPOGRAPHY_PROPS = [
  'font-family',
  'font-weight',
  'font-style',
  'color',
  'text-align',
  'text-transform',
] as const

/**
 * Scale a computed CSS px length by the iframe zoom factor. Keywords
 * (`normal`), unitless values, and non-px units pass through untouched —
 * getComputedStyle resolves lengths to px in browsers, so anything else is
 * already zoom-independent for our purposes.
 */
export function scaleCssLength(value: string, scale: number): string {
  const match = /^(-?\d*\.?\d+)px$/.exec(value.trim())
  if (!match) return value
  return `${Number.parseFloat(match[1]) * scale}px`
}

/**
 * Mirror the edited element's live typography onto the parent-document
 * inline-edit field, so the floating <textarea>/<input> reads as the text
 * it replaces. Reads through `iframe.contentWindow.getComputedStyle` (the
 * frames are same-origin `srcdoc` iframes) and scales px lengths by the
 * iframe zoom factor — the field lives in UNSCALED parent coordinates.
 *
 * NOTE: this is why the hide-doubled-text rule uses
 * `-webkit-text-fill-color: transparent` and not `color: transparent` —
 * the computed `color` read here must stay the authored color.
 */
export function mirrorInlineEditTypography(
  field: HTMLElement,
  target: HTMLElement,
  iframe: HTMLIFrameElement,
): void {
  const view = iframe.contentWindow
  if (!view) return
  const computed = view.getComputedStyle(target)
  const iframeScale =
    iframe.offsetWidth > 0 ? iframe.getBoundingClientRect().width / iframe.offsetWidth : 1
  for (const prop of SCALED_TYPOGRAPHY_PROPS) {
    field.style.setProperty(prop, scaleCssLength(computed.getPropertyValue(prop), iframeScale))
  }
  for (const prop of COPIED_TYPOGRAPHY_PROPS) {
    field.style.setProperty(prop, computed.getPropertyValue(prop))
  }
}
```

- [ ] Run and expect pass:

```bash
bun test src/__tests__/canvas/canvasOverlayGeometry.test.ts
```

- [ ] Commit:

```bash
git add src/admin/pages/site/canvas/canvasOverlayGeometry.ts src/__tests__/canvas/canvasOverlayGeometry.test.ts
git commit -m "$(cat <<'EOF'
feat(canvas): add inline-edit typography mirroring helpers

scaleCssLength + mirrorInlineEditTypography — computed styles read through
iframe.contentWindow, px lengths scaled by the iframe zoom factor so the
parent-doc field matches the text it floats over at every zoom level.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: InlineTextEditOverlay component + per-frame mount

**Files:**
- Create: `src/admin/pages/site/canvas/InlineTextEditOverlay.tsx`
- Create: `src/admin/pages/site/canvas/InlineTextEditOverlay.module.css`
- Modify: `src/admin/pages/site/canvas/BreakpointFrame.tsx` (import block lines 23-26; mount after line 260)
- Test: `src/__tests__/canvas/inlineTextEditOverlay.test.tsx`

- [ ] Write the failing test. Create `src/__tests__/canvas/inlineTextEditOverlay.test.tsx`:

```tsx
/**
 * InlineTextEditOverlay component tests — per-frame render gating, field
 * variant (textarea vs input), live commit through the store, and the
 * Enter / Shift+Enter / Escape / blur / unmount end-of-session semantics.
 *
 * iframeElement is null in these tests: positioning + typography mirroring
 * need a live iframe (covered by the manual smoke test); the session
 * semantics under test are iframe-independent.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import React from 'react'
import { render, fireEvent, cleanup } from '@testing-library/react'
import { useEditorStore } from '@site/store/store'
import { InlineTextEditOverlay } from '@site/canvas/InlineTextEditOverlay'
import '@modules/base/text'
import '@modules/base/button'

const FIELD_SELECTOR = '[data-testid="canvas-inline-edit-field"]'

function seedSession(multiline = true): { nodeId: string } {
  const store = useEditorStore.getState()
  const site = store.createSite('Overlay Test Site')
  const rootId = site.pages[0].rootNodeId
  const nodeId = multiline
    ? useEditorStore.getState().insertNode('base.text', { text: 'Hello' }, rootId)
    : useEditorStore.getState().insertNode('base.button', { label: 'Hello' }, rootId)
  useEditorStore.getState().startInlineEdit(nodeId, 'bp-a')
  return { nodeId }
}

function storedValue(nodeId: string): unknown {
  const node = useEditorStore.getState().site!.pages[0].nodes[nodeId]
  return node.props.text ?? node.props.label
}

function queryField(): HTMLTextAreaElement | HTMLInputElement | null {
  return document.querySelector<HTMLTextAreaElement | HTMLInputElement>(FIELD_SELECTOR)
}

beforeEach(() => {
  useEditorStore.setState({
    site: null,
    activePageId: null,
    activeDocument: null,
    activeInlineEdit: null,
    _historyPast: [],
    _historyFuture: [],
    _historyCoalesceKey: null,
    canUndo: false,
    canRedo: false,
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
    hasUnsavedChanges: false,
  })
})

afterEach(() => {
  cleanup()
})

describe('InlineTextEditOverlay', () => {
  it('renders nothing without a session', () => {
    render(<InlineTextEditOverlay breakpointId="bp-a" iframeElement={null} />)
    expect(queryField()).toBeNull()
  })

  it('renders nothing for a session owned by another frame', () => {
    seedSession()
    render(<InlineTextEditOverlay breakpointId="bp-b" iframeElement={null} />)
    expect(queryField()).toBeNull()
  })

  it('renders a textarea seeded with the current value for multiline sessions', () => {
    seedSession(true)
    render(<InlineTextEditOverlay breakpointId="bp-a" iframeElement={null} />)
    const field = queryField()
    expect(field?.tagName).toBe('TEXTAREA')
    expect(field?.value).toBe('Hello')
  })

  it('renders an input for single-line sessions', () => {
    seedSession(false)
    render(<InlineTextEditOverlay breakpointId="bp-a" iframeElement={null} />)
    expect(queryField()?.tagName).toBe('INPUT')
  })

  it('live-commits every change through the store', () => {
    const { nodeId } = seedSession(true)
    render(<InlineTextEditOverlay breakpointId="bp-a" iframeElement={null} />)
    fireEvent.change(queryField()!, { target: { value: 'Hello world' } })
    expect(storedValue(nodeId)).toBe('Hello world')
    expect(useEditorStore.getState().activeInlineEdit?.committed).toBe(true)
  })

  it('Enter commits and closes (multiline included — base.text renders no newlines)', () => {
    const { nodeId } = seedSession(true)
    render(<InlineTextEditOverlay breakpointId="bp-a" iframeElement={null} />)
    const field = queryField()!
    fireEvent.change(field, { target: { value: 'Edited' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(useEditorStore.getState().activeInlineEdit).toBeNull()
    expect(storedValue(nodeId)).toBe('Edited')
  })

  it('Shift+Enter keeps a multiline session open (native newline)', () => {
    seedSession(true)
    render(<InlineTextEditOverlay breakpointId="bp-a" iframeElement={null} />)
    fireEvent.keyDown(queryField()!, { key: 'Enter', shiftKey: true })
    expect(useEditorStore.getState().activeInlineEdit).not.toBeNull()
  })

  it('Escape cancels and restores the initial value', () => {
    const { nodeId } = seedSession(true)
    render(<InlineTextEditOverlay breakpointId="bp-a" iframeElement={null} />)
    const field = queryField()!
    fireEvent.change(field, { target: { value: 'Mangled' } })
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(useEditorStore.getState().activeInlineEdit).toBeNull()
    expect(storedValue(nodeId)).toBe('Hello')
  })

  it('blur commits and closes', () => {
    const { nodeId } = seedSession(true)
    render(<InlineTextEditOverlay breakpointId="bp-a" iframeElement={null} />)
    const field = queryField()!
    fireEvent.change(field, { target: { value: 'Blurred' } })
    fireEvent.blur(field)
    expect(useEditorStore.getState().activeInlineEdit).toBeNull()
    expect(storedValue(nodeId)).toBe('Blurred')
  })

  it('force-closes the session when the frame unmounts mid-session', () => {
    seedSession(true)
    const { unmount } = render(<InlineTextEditOverlay breakpointId="bp-a" iframeElement={null} />)
    unmount()
    expect(useEditorStore.getState().activeInlineEdit).toBeNull()
  })
})
```

- [ ] Run and expect failure:

```bash
bun test src/__tests__/canvas/inlineTextEditOverlay.test.tsx
```

Expected: module resolution error — `Cannot find module '@site/canvas/InlineTextEditOverlay'`.

- [ ] Create `src/admin/pages/site/canvas/InlineTextEditOverlay.module.css`:

```css
/**
 * InlineTextEditOverlay — parent-document inline text editor positioned over
 * the edited node inside a breakpoint iframe.
 *
 * The layer is portaled into the canvas root (same pattern as the rings in
 * BreakpointSelectionOverlay.module.css) so it escapes the transform layer's
 * scale; the field is positioned in screen-px via transform by the RAF tick.
 * Typography is mirrored inline (style attribute) from the live element, so
 * this file only owns chrome: transparent background, no border, focus ring
 * from the canvas selection affordance token.
 */

.layer {
    position: absolute;
    inset: 0;
    pointer-events: none;
    /* Interactive editor chrome: above the selection rings (51), same range
     * as the selection toolbar's drag handle (52) so it stacks predictably
     * below sidebars (55), dialogs (95+), and editor toolbars (200+). */
    z-index: 52;
}

/* Fallback when no canvas root is wired in (tests, transient mount race) —
   portaled to document.body, mirrors the rings' fixed-position fallback. */
.layer[data-canvas-inline-edit-mode="fixed"] {
    position: fixed;
}

.field {
    position: absolute;
    top: 0;
    left: 0;
    box-sizing: border-box;
    display: block;
    margin: 0;
    padding: 0;
    border: none;
    border-radius: 1px;
    background: transparent;
    outline: none;
    overflow: hidden;
    resize: none;
    pointer-events: auto;
    box-shadow: var(--canvas-selection-ring);
}
```

- [ ] Create `src/admin/pages/site/canvas/InlineTextEditOverlay.tsx`:

```tsx
/**
 * InlineTextEditOverlay — the canvas inline text editor (double-click to edit).
 *
 * A real `<textarea>`/`<input>` in the PARENT document, portaled into the
 * canvas root and positioned over the edited node inside the breakpoint
 * iframe — no cross-frame focus negotiation, which is what made the old
 * in-iframe contentEditable editor unshippable (see
 * docs/features/canvas-iframe-per-frame.md). Mirrors the
 * BreakpointSelectionOverlay portal + RAF-tracking pattern so the field
 * follows pan / zoom / reflow.
 *
 * Session state lives in the editor store (`activeInlineEdit` — one session
 * globally, owned by the breakpoint frame that was double-clicked). Every
 * keystroke commits live through `applyInlineEditValue` → `updateNodeProps`,
 * so all OTHER frames preview the change while THIS frame hides the node's
 * own text (`data-instatic-inline-editing` in NodeRenderer + the
 * CANVAS_CHROME_CSS rule in IframeFrameSurface).
 *
 * End-of-session semantics (mirrors the removed in-iframe editor):
 *   - Enter / Cmd+Enter / Ctrl+Enter → commit + close. base.text does not
 *     render newlines (its render() interpolates raw text into HTML where
 *     whitespace collapses), so plain Enter commits in BOTH modes;
 *     Shift+Enter in multiline falls through to the native newline for
 *     authors who add `white-space: pre-wrap` via their own CSS.
 *   - Blur → commit + close.
 *   - Escape → cancel (single undo of the coalesced burst iff committed).
 *   - Node unmounted / rect unmeasurable / frame unmount → force-close.
 */
import { use, useEffect, useEffectEvent, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useEditorStore } from '@site/store/store'
import { CanvasViewportActionsContext } from './CanvasContexts'
import { escapeCssAttributeValue } from './canvasNodeLookup'
import { measureCanvasElementRect, mirrorInlineEditTypography } from './canvasOverlayGeometry'
import styles from './InlineTextEditOverlay.module.css'

interface InlineTextEditOverlayProps {
  /**
   * The breakpoint frame this overlay belongs to — it only renders when the
   * active session was started from this frame.
   */
  breakpointId: string
  /** The frame's iframe element; rect + typography are measured inside it. */
  iframeElement: HTMLIFrameElement | null
}

export function InlineTextEditOverlay({ breakpointId, iframeElement }: InlineTextEditOverlayProps) {
  const session = useEditorStore((s) =>
    s.activeInlineEdit?.breakpointId === breakpointId ? s.activeInlineEdit : null,
  )
  const applyInlineEditValue = useEditorStore((s) => s.applyInlineEditValue)
  const endInlineEdit = useEditorStore((s) => s.endInlineEdit)
  const cancelInlineEdit = useEditorStore((s) => s.cancelInlineEdit)
  const fieldRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)
  const viewportActions = use(CanvasViewportActionsContext)

  // Stable per-session identity. The session OBJECT is replaced when
  // `committed` flips on the first keystroke — keying the effect (and the
  // field's defaultValue reset) on the object would re-run focus +
  // select-all mid-typing and clobber the user's caret.
  const sessionKey = session ? `${session.nodeId}:${session.prop}` : null

  // Each RAF tick reads the freshest session / iframe / canvas root from the
  // latest render closure — same pattern as BreakpointSelectionOverlay.
  const tickOnce = useEffectEvent(() => {
    const field = fieldRef.current
    if (!field || !session || !iframeElement) return
    const target =
      iframeElement.contentDocument?.querySelector<HTMLElement>(
        `[data-node-id="${escapeCssAttributeValue(session.nodeId)}"]`,
      ) ?? null
    const canvasRoot = viewportActions?.canvasRootRef.current ?? null
    const rect = measureCanvasElementRect(target, iframeElement, canvasRoot)
    if (!rect || !target) {
      // Node unmounted mid-session (deleted / hidden / page recomposed).
      // Keystrokes already committed live — just close the session.
      endInlineEdit()
      return
    }
    field.style.transform = `translate(${rect.x}px, ${rect.y}px)`
    field.style.width = `${rect.width}px`
    field.style.height = `${rect.height}px`
    mirrorInlineEditTypography(field, target, iframeElement)
  })

  // Position + typography RAF loop, armed only while this frame owns the
  // session. The first tick runs synchronously so the field never flashes at
  // (0,0); focus + select-all mirror the removed in-iframe editor's
  // enter-edit-mode behaviour (commit 934df7d4).
  useEffect(() => {
    if (!sessionKey || !iframeElement) return
    tickOnce()
    const field = fieldRef.current
    field?.focus()
    field?.select()
    let frame = 0
    let cancelled = false
    const tick = () => {
      if (cancelled) return
      tickOnce()
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
    }
  }, [sessionKey, iframeElement])

  // Force-close when this frame unmounts mid-session (breakpoint collapsed /
  // removed, canvas switched to live mode). Imperative store read — the
  // cleanup must see the freshest session, not the one captured at mount.
  useEffect(() => {
    return () => {
      const current = useEditorStore.getState()
      if (current.activeInlineEdit?.breakpointId === breakpointId) {
        current.endInlineEdit()
      }
    }
  }, [breakpointId])

  if (!session) return null

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    applyInlineEditValue(e.currentTarget.value)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    // Keep EVERY keystroke out of the canvas-root shortcut layer — Escape
    // there clears the selection / exits VC mode, Cmd/Ctrl+D duplicates the
    // node, and zoom keys fire. The field owns typing entirely.
    e.stopPropagation()
    if (e.key === 'Escape') {
      e.preventDefault()
      cancelInlineEdit()
      return
    }
    if (e.key === 'Enter') {
      // Plain Enter commits in BOTH modes — base.text doesn't render
      // newlines (whitespace collapses in the published HTML). Shift+Enter
      // in multiline inserts a native newline for authors who opt into
      // `white-space: pre-wrap` with their own CSS.
      if (session.multiline && e.shiftKey && !e.metaKey && !e.ctrlKey) return
      e.preventDefault()
      endInlineEdit()
    }
  }

  // Keystrokes already committed live — blur just closes the session.
  const handleBlur = () => endInlineEdit()

  // Clicks/drags inside the field must not reach the canvas root: its
  // onClick clears the selection and the gesture layer would treat the
  // text-selection drag as a pan.
  const stopMouse = (e: React.SyntheticEvent) => e.stopPropagation()

  const canvasRoot = viewportActions?.canvasRootRef.current ?? null
  const portalTarget = canvasRoot ?? document.body
  const positionMode = canvasRoot ? 'scoped' : 'fixed'

  const fieldProps = {
    className: styles.field,
    defaultValue: session.initialValue,
    'aria-label': 'Edit text inline',
    'data-testid': 'canvas-inline-edit-field',
    spellCheck: false,
    onChange: handleChange,
    onKeyDown: handleKeyDown,
    onBlur: handleBlur,
    onPointerDown: stopMouse,
    onClick: stopMouse,
    onDoubleClick: stopMouse,
    onContextMenu: stopMouse,
  }

  return createPortal(
    <div className={styles.layer} data-canvas-inline-edit-mode={positionMode}>
      {session.multiline ? (
        <textarea
          key={sessionKey}
          {...fieldProps}
          ref={(el) => {
            fieldRef.current = el
          }}
          rows={1}
        />
      ) : (
        <input
          key={sessionKey}
          {...fieldProps}
          ref={(el) => {
            fieldRef.current = el
          }}
          type="text"
        />
      )}
    </div>,
    portalTarget,
  )
}
```

- [ ] Mount it per design frame. In `src/admin/pages/site/canvas/BreakpointFrame.tsx`, add to the import block (after line 24, `BreakpointSelectionOverlay`):

```tsx
import { InlineTextEditOverlay } from './InlineTextEditOverlay'
```

and insert directly after the `<BreakpointSelectionOverlay … />` element (after line 260):

```tsx
        {/* Inline text editor — parent-doc field floated over the edited
            node in THIS frame. Renders only while this frame owns the
            active inline-edit session. */}
        <InlineTextEditOverlay
          breakpointId={breakpoint.id}
          iframeElement={iframeEl}
        />
```

- [ ] Run and expect pass:

```bash
bun test src/__tests__/canvas/inlineTextEditOverlay.test.tsx
```

- [ ] Commit:

```bash
git add src/admin/pages/site/canvas/InlineTextEditOverlay.tsx src/admin/pages/site/canvas/InlineTextEditOverlay.module.css src/admin/pages/site/canvas/BreakpointFrame.tsx src/__tests__/canvas/inlineTextEditOverlay.test.tsx
git commit -m "$(cat <<'EOF'
feat(canvas): add InlineTextEditOverlay, mounted per breakpoint frame

Parent-document textarea/input portaled into the canvas root and
RAF-tracked over the node rect (BreakpointSelectionOverlay pattern), with
live commit per keystroke, select-all on entry, Enter/blur commit,
Shift+Enter newline in multiline, Escape cancel, and force-close on node
unmount / frame unmount.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Wire double-click + hide doubled text in the session's frame

**Files:**
- Modify: `src/admin/pages/site/canvas/CanvasContexts.ts` (lines 8, 15)
- Modify: `src/core/module-engine/types.ts` (NodeWrapperProps, after line 114 `'data-hovered'?: 'true'`)
- Modify: `src/admin/pages/site/canvas/NodeRenderer.tsx` (after line 61; line ~194; lines 233-249)
- Modify: `src/admin/pages/site/canvas/CanvasRoot.tsx` (store subscriptions ~line 111; lines 287-304)
- Modify: `src/admin/pages/site/canvas/IframeFrameSurface.tsx` (CANVAS_CHROME_CSS, lines 650-661)
- Test: `src/__tests__/canvas/inlineTextEditingWiring.test.ts`

- [ ] Write the failing test (source-assertion style, same convention as `src/__tests__/canvas/canvasNotch.test.ts`). Create `src/__tests__/canvas/inlineTextEditingWiring.test.ts`:

```ts
/**
 * Inline text editing — canvas wiring gates.
 *
 * Source-assertion tests (canvasNotch.test.ts convention) for the pieces
 * that only manifest inside live iframes and the full canvas mount:
 * double-click → startInlineEdit, the per-frame hidden-text attribute, and
 * the canvas-chrome CSS rule that must NOT use `color: transparent`
 * (the overlay mirrors computed color for the field's own text).
 */
import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'fs'

const CANVAS_ROOT = new URL('../../admin/pages/site/canvas/CanvasRoot.tsx', import.meta.url)
const NODE_RENDERER = new URL('../../admin/pages/site/canvas/NodeRenderer.tsx', import.meta.url)
const IFRAME_SURFACE = new URL('../../admin/pages/site/canvas/IframeFrameSurface.tsx', import.meta.url)
const BREAKPOINT_FRAME = new URL('../../admin/pages/site/canvas/BreakpointFrame.tsx', import.meta.url)
const CONTEXTS = new URL('../../admin/pages/site/canvas/CanvasContexts.ts', import.meta.url)

describe('inline text editing wiring', () => {
  it('CanvasRoot starts a session on node double-click, gated to design mode', () => {
    const src = readFileSync(CANVAS_ROOT, 'utf-8')
    expect(src).toContain('startInlineEdit')
    expect(src).toContain('permissions.canEditContent')
  })

  it('the double-click context channel carries the originating breakpoint', () => {
    const src = readFileSync(CONTEXTS, 'utf-8')
    expect(src).toContain('onNodeDoubleClick: (nodeId: string, e: MouseEvent, breakpointId?: string) => void')
  })

  it('NodeRenderer flags the edited node in the session frame only', () => {
    const src = readFileSync(NODE_RENDERER, 'utf-8')
    expect(src).toContain("'data-instatic-inline-editing'")
    expect(src).toContain('s.activeInlineEdit.breakpointId === breakpointId')
  })

  it('the canvas chrome hides doubled text via text-fill-color, never color', () => {
    const src = readFileSync(IFRAME_SURFACE, 'utf-8')
    expect(src).toContain('[data-instatic-inline-editing="true"]')
    expect(src).toContain('-webkit-text-fill-color: transparent !important')
    // The overlay mirrors getComputedStyle(el).color — color:transparent
    // would feed transparent back into the field's own text.
    expect(src).not.toContain('color: transparent !important')
  })

  it('BreakpointFrame mounts the overlay next to the selection overlay', () => {
    const src = readFileSync(BREAKPOINT_FRAME, 'utf-8')
    expect(src).toContain('<InlineTextEditOverlay')
  })
})
```

- [ ] Run and expect failure:

```bash
bun test src/__tests__/canvas/inlineTextEditingWiring.test.ts
```

Expected: 4 failures (CanvasRoot, contexts, NodeRenderer, chrome CSS); the BreakpointFrame assertion already passes from Task 6.

- [ ] Extend the context channel. In `src/admin/pages/site/canvas/CanvasContexts.ts`, change line 8:

```ts
  onNodeDoubleClick: (nodeId: string, e: MouseEvent, breakpointId?: string) => void
```

(The default no-op on line 15 stays `onNodeDoubleClick: () => {}` — compatible.)

- [ ] Add the wrapper-prop field. In `src/core/module-engine/types.ts`, inside `NodeWrapperProps` after `'data-hovered'?: 'true'` (line 114):

```ts
  /**
   * Present on the node's root element in the breakpoint frame that owns an
   * active inline text-edit session. The canvas-chrome CSS
   * (CANVAS_CHROME_CSS in IframeFrameSurface) keys off it to paint the
   * node's own text transparent while the parent-document overlay floats
   * over it — in that one frame only; other frames keep showing the
   * live-updating text.
   */
  'data-instatic-inline-editing'?: 'true'
```

- [ ] Wire `NodeRenderer`. In `src/admin/pages/site/canvas/NodeRenderer.tsx`:

(a) after the `isHovered` subscription (line 61), add:

```ts
  // Inline text edit session — true only in the SESSION'S frame, so the
  // doubled text is hidden where the overlay floats while every other
  // breakpoint frame keeps previewing the live-updating text.
  const isInlineEditing = useEditorStore(
    (s) =>
      s.activeInlineEdit !== null &&
      s.activeInlineEdit.nodeId === nodeId &&
      s.activeInlineEdit.breakpointId === breakpointId,
  )
```

(b) in the `nodeWrapperProps` literal, after the `isHovered` spread (line 194), add:

```ts
    ...(isInlineEditing ? { 'data-instatic-inline-editing': 'true' as const } : {}),
```

(c) pass the frame id on both double-click handlers (lines 238 and 248), changing each call to:

```ts
      onNodeDoubleClick(nodeId, e as unknown as React.MouseEvent, breakpointId)
```

- [ ] Wire `CanvasRoot`. In `src/admin/pages/site/canvas/CanvasRoot.tsx`:

(a) add the store subscription next to `setActiveBreakpoint` (line 111):

```ts
  const startInlineEdit = useEditorStore((s) => s.startInlineEdit)
```

(b) replace the no-op handler and its comment (lines 287-304) with:

```ts
  /**
   * Double-click on a canvas node → start an inline text-edit session when
   * the node's module declares `inlineTextEdit` (base.text, base.button,
   * childless base.link — `startInlineEdit` resolves the contract and
   * no-ops for everything else, so other modules keep the old no-op).
   *
   * Design-canvas only: the InlineTextEditOverlay mounts per
   * BreakpointFrame, so a live-mode double-click must not open a session
   * that nothing renders. Entering VC canvas mode on double-click stays
   * removed — VC entry works from the Site panel and Spotlight (see
   * `docs/features/canvas-iframe-per-frame.md`).
   */
  const onNodeDoubleClick = (nodeId: string, e: React.MouseEvent, breakpointId?: string) => {
    e.stopPropagation()
    if (isLive || !editable || !permissions.canEditContent) return
    startInlineEdit(nodeId, breakpointId ?? activeBreakpointId)
  }
```

- [ ] Hide the doubled text. In `src/admin/pages/site/canvas/IframeFrameSurface.tsx`, extend `CANVAS_CHROME_CSS` (lines 650-661) — insert before the `'iframe { pointer-events: none; }',` entry:

```ts
  // Inline text edit: hide the edited node's own text in the session's
  // frame only (NodeRenderer sets the attribute per-frame). Uses
  // -webkit-text-fill-color — NOT color — because the parent-doc overlay
  // mirrors iframe getComputedStyle(el).color for the floating field's own
  // text; color:transparent would mirror to an invisible field.
  '[data-instatic-inline-editing="true"] {',
  '  -webkit-text-fill-color: transparent !important;',
  '  text-shadow: none !important;',
  '}',
```

- [ ] Run and expect pass, plus the neighbours that exercise the touched files:

```bash
bun test src/__tests__/canvas/ src/__tests__/editor-store/inlineEditSlice.test.ts src/__tests__/canvas/canvasNotch.test.ts
```

Expected: all pass.

- [ ] Commit:

```bash
git add src/admin/pages/site/canvas/CanvasContexts.ts src/core/module-engine/types.ts src/admin/pages/site/canvas/NodeRenderer.tsx src/admin/pages/site/canvas/CanvasRoot.tsx src/admin/pages/site/canvas/IframeFrameSurface.tsx src/__tests__/canvas/inlineTextEditingWiring.test.ts
git commit -m "$(cat <<'EOF'
feat(canvas): wire double-click inline editing and hide doubled text

onNodeDoubleClick carries the originating breakpoint and starts a session
(design mode, content-edit permission); NodeRenderer flags the edited node
in the session's frame; CANVAS_CHROME_CSS paints it transparent via
-webkit-text-fill-color so the overlay can still mirror computed color.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Documentation

**Files:**
- Modify: `docs/features/canvas-iframe-per-frame.md` (delete the "### Inline text editing removed" limitation, lines 160-166; add a new section before "## Plugin module sandboxing", line 154)
- Modify: `docs/editor.md` (slice count + table ~lines 329-345; canvas behaviour paragraph before "### CSS injection into the iframe", line 411; key-files table, line 464)

- [ ] In `docs/features/canvas-iframe-per-frame.md`, DELETE the Known-limitations subsection (lines 162-166):

```md
### Inline text editing removed

Double-click to edit text/button content in-place was removed when the iframe move landed. The cross-frame focus model (iframe needs system focus, body competes, React StrictMode double-mount races) made every fix fragile. Text and button content is edited through the Properties panel.

When revisited, the shape worth considering is a parent-doc overlay positioned over the iframe element — a real `<input>`/`<textarea>` in the parent doc, no iframe focus negotiation needed.
```

- [ ] In the same file, insert a new section between "## Event handling across the iframe boundary" and "## Plugin module sandboxing" (before line 154):

```md
## Inline text editing (parent-doc overlay)

Double-click a text-bearing node to edit its text in place. The editor is a real `<textarea>`/`<input>` in the **parent document** (`InlineTextEditOverlay.tsx`), portaled into the canvas root and positioned over the node inside the breakpoint iframe with the same RAF tracking the selection rings use — no cross-frame focus negotiation, which is what made the old in-iframe `contentEditable` editor unshippable.

- **Module contract:** `ModuleDefinition.inlineTextEdit?: { prop: string; multiline?: boolean }`. Declared by `base.text` (`text`, multiline), `base.button` (`label`), and `base.link` (`text`). Modules without the field keep the no-op double-click; the canvas has no per-module branches. A node with children never starts a session (`base.link` renders `text` only when childless), and dynamically-bound props are not literal-editable.
- **Session state:** `activeInlineEdit { nodeId, prop, breakpointId, multiline, initialValue, committed }` in `store/slices/inlineEditSlice.ts`. One session globally, owned by the frame that was double-clicked. Design mode only.
- **Live commit:** every keystroke calls `updateNodeProps(nodeId, { [prop]: value })`. Single-field patches coalesce under `props:<nodeId>:<prop>`, so the whole burst is ONE undo entry and every other frame previews the edit live. `startInlineEdit`/`endInlineEdit` reset `_historyCoalesceKey` so the session burst never folds into a Properties-panel burst for the same prop.
- **Hidden doubled text:** the edited node — in the session's frame only — carries `data-instatic-inline-editing`, and the canvas-chrome CSS paints it with `-webkit-text-fill-color: transparent` (NOT `color: transparent`: the overlay mirrors the element's computed `color` for the field's own text).
- **Typography mirroring:** `mirrorInlineEditTypography` (canvasOverlayGeometry.ts) copies font family/weight/style, color, text-align, and text-transform from `iframe.contentWindow.getComputedStyle(el)` and scales font-size / line-height / letter-spacing by the iframe zoom factor on every RAF tick.
- **End:** Enter or Cmd/Ctrl+Enter commits + closes — plain Enter commits even in multiline mode because `base.text` renders raw text into HTML where newlines collapse; Shift+Enter inserts a native newline for authors who add `white-space: pre-wrap` themselves. Blur commits + closes. Escape cancels: a single `undo()` iff the session committed anything.
- **Force-close:** node deleted (pruned in `pruneCanvasSelectionDraft`), document/page switch (`clearCanvasSelectionDraft`), frame unmount (breakpoint collapsed, live-mode switch), or an unmeasurable rect mid-session.

Keyboard interplay: the field lives in the parent document, so the existing `isTextInputTarget` guards already keep Delete/clipboard shortcuts out, and the field stops propagation of every keystroke so the canvas-root handler (Escape-clears-selection, duplicate, zoom keys) never sees them.

Design doc: `docs/superpowers/specs/2026-06-10-inline-text-editing-design.md`.

---
```

- [ ] In `docs/editor.md`:

(a) change line 329 `The store is composed of **11 slices**, each created by a factory in `store/slices/`:` to `**12 slices**` and add a table row after the `clipboardSlice` row (line 344):

```md
| `inlineEditSlice`      | `activeInlineEdit` — the canvas inline text-edit session (double-click to edit) |
```

(b) insert a new subsection before `### CSS injection into the iframe` (line 411):

```md
### Inline text editing (double-click)

Double-clicking a node whose module declares `inlineTextEdit` (`base.text`, `base.button`, childless `base.link`) opens `InlineTextEditOverlay` — a real `<textarea>`/`<input>` in the parent document, portaled into the canvas root and RAF-tracked over the node's rect inside the breakpoint iframe (same portal + RAF pattern as the selection rings). Typography is mirrored from the live element via the iframe's `getComputedStyle`, scaled by the iframe zoom factor. Every keystroke commits live through `updateNodeProps`, so all breakpoint frames preview the edit while the session's own frame hides the node's text (`data-instatic-inline-editing` + a canvas-chrome rule). The whole burst coalesces into one undo entry; Enter/blur commit + close, Escape reverts via a single `undo()`. Session state is `activeInlineEdit` in `inlineEditSlice`. Full design: [`docs/features/canvas-iframe-per-frame.md`](features/canvas-iframe-per-frame.md) → "Inline text editing (parent-doc overlay)".
```

(c) add to the Key canvas files table (after the `BreakpointSelectionOverlay.tsx` row, ~line 483):

```md
| `InlineTextEditOverlay.tsx`     | Parent-doc inline text editor floated over a node in the breakpoint iframe (double-click to edit) |
```

- [ ] Sanity-check the docs edits:

```bash
grep -n "Inline text editing (parent-doc overlay)" docs/features/canvas-iframe-per-frame.md && ! grep -n "Inline text editing removed" docs/features/canvas-iframe-per-frame.md && grep -n "inlineEditSlice" docs/editor.md
```

Expected: the new section heading found; the removed-limitation heading gone; two `inlineEditSlice` hits in editor.md.

- [ ] Commit:

```bash
git add docs/features/canvas-iframe-per-frame.md docs/editor.md
git commit -m "$(cat <<'EOF'
docs: document canvas inline text editing (parent-doc overlay)

Replaces the "inline text editing removed" known-limitation with the
implemented design; adds the inlineEditSlice and InlineTextEditOverlay to
the editor reference.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Full verification

**Files:** none (verification only; fix-up commits only for failures CAUSED by this branch).

- [ ] Install and run the full suite:

```bash
bun install
bun test
```

Expected: all tests pass. **Triage rule:** only failures caused by this branch matter. For any failure, check whether it also fails on the base commit (`git stash && git checkout 0503316e -- . && bun test <failing-file>` in a scratch checkout, or simply `git worktree`-compare) — pre-existing failures on main are out of scope and must NOT be "fixed" here. Failures in `src/__tests__/editor-store/`, `src/__tests__/canvas/`, `src/__tests__/base-modules*`, or `src/__tests__/architecture/` that mention `inlineTextEdit`, `activeInlineEdit`, or files this branch touched are ours: fix in the task that introduced them and amend with a `fix:` commit.

- [ ] Type-check + production build:

```bash
bun run build
```

Expected: `tsc -b` clean (the `inlineTextEdit` field, `NodeWrapperProps` addition, and slice augmentation must type-check across all consumers) and a successful vite build.

- [ ] Lint:

```bash
bun run lint
```

Expected: clean. Likely trip-points if any step deviated: `react-hooks/exhaustive-deps` on the overlay's RAF effect (`tickOnce` is a `useEffectEvent` and must NOT be listed as a dep — same as `BreakpointSelectionOverlay`), and the CSS-token gates (`no-css-var-fallbacks`, `css-token-policy`) on the new module CSS (it only uses `var(--canvas-selection-ring)` with no fallback, which is compliant).

- [ ] Optional manual smoke test (needs local seeded data): `bun run dev`, open the site editor, then verify: double-click a text node → overlay opens with all text selected → typing updates every breakpoint frame live while the edited frame shows only the field → Enter commits → one Cmd/Cmd+Z restores the pre-edit text → double-click again, type, Escape restores → with the field focused, Cmd/Ctrl+D and Delete do nothing to the layer → double-click a `base.link` that has children does nothing → pan/zoom while editing keeps the field glued to the node.

- [ ] If everything is green, the branch is complete — hand off per the executing-plans / finishing-a-development-branch workflow.