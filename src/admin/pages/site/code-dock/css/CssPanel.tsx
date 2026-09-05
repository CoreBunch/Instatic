/**
 * CssPanel — the Code Dock's CSS column: a two-way editor over the style-rule
 * registry (docs/features/god-mode.md → "CSS panel").
 *
 * Read side: `deriveCssPanelDocument` projects the rules the selection uses
 * (or the whole page) into one annotated stylesheet; framework utilities are
 * locked + folded in the editor. Write side: every debounced change is
 * planned by `planStylesheetEdit` and applied through `applyStylesheetEdit`
 * — one flush, one undo step; the canvas repaints from the registry as you
 * type. Applies are held back while the document has syntax errors, because
 * the CSS parser silently swallows everything after a missing brace.
 *
 * The editor is only remounted when the projected document changes for a
 * reason other than this panel's own apply (selection change, canvas undo,
 * a co-editor's edit) — see `useDocumentSync`. A buffer that does not parse
 * (so nothing was applied) is stashed in the store (`codeDockDrafts`) and
 * restored when the same document mounts again, so expanding the panel or
 * the tab fallback cannot lose it.
 */
import { lazy, Suspense, useDeferredValue, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { planStylesheetEdit } from '@core/cssProjection'
import { useEditorStore } from '@site/store/store'
import { findRenderedCanvasNodeElement } from '@site/canvas/canvasNodeLookup'
import type { CodeMirrorEditorHandle, EditorChangeInfo } from '@site/code-editor/CodeMirrorEditor'
import { pushToast } from '@ui/components/Toast'
import { cn } from '@ui/cn'
import { useDocumentSync, type DocumentSyncSource } from '../useDocumentSync'
import { deriveCssCompletionCatalog } from '../completions'
import { FormatButton } from '../FormatButton'
import { deriveCssPanelDocument, type CssPanelCanvas, type CssPanelDocument } from './cssPanelDocument'
import { selectSelectionScope, selectionScopeEqual, type SelectionScopeInputs } from '../selectionScope'
import styles from '../EditorColumn.module.css'

const CodeMirrorEditor = lazy(() => import('@site/code-editor/CodeMirrorEditor'))

/** Live-apply debounce: long enough to coalesce a burst of typing into one undo step. */
export const CSS_PANEL_APPLY_DELAY_MS = 300

const canvas: CssPanelCanvas = {
  findNodeElement: (nodeId) => findRenderedCanvasNodeElement(nodeId),
}

type PanelStatus =
  | { kind: 'idle' }
  | { kind: 'syntax'; count: number }
  | { kind: 'blocked'; selectors: string[] }
  | { kind: 'warning'; message: string }

function statusText(status: PanelStatus): string {
  switch (status.kind) {
    case 'idle':
      return 'Edits apply live · shared classes change site-wide'
    case 'syntax':
      return `Not applied: ${status.count} syntax error${status.count === 1 ? '' : 's'}`
    case 'blocked':
      return `Read-only framework utilities skipped: ${status.selectors.join(', ')}`
    case 'warning':
      return status.message
  }
}

const syncSource: DocumentSyncSource<SelectionScopeInputs> = {
  select: selectSelectionScope,
  equal: selectionScopeEqual,
  read: (inputs) => {
    const next = deriveCssPanelDocument(inputs, canvas)
    return next ? { docKey: next.docKey, text: next.projection.text } : null
  },
}

export function CssPanel() {
  // Deferred: the page-scope stylesheet is derived once a burst of store
  // changes settles, not per change.
  const inputs = useDeferredValue(useEditorStore(useShallow(selectSelectionScope)))
  const applyStylesheetEdit = useEditorStore((s) => s.applyStylesheetEdit)
  const setCodeDockDraft = useEditorStore((s) => s.setCodeDockDraft)
  const storedDrafts = useEditorStore((s) => s.codeDockDrafts)
  const document: CssPanelDocument | null = deriveCssPanelDocument(inputs, canvas)
  // Status is remembered with the scope it belongs to, so a scope change
  // resets it without an effect.
  const [scopedStatus, setScopedStatus] = useState<{ docKey: string; status: PanelStatus } | null>(null)
  const { revision, runOwnWrite } = useDocumentSync(syncSource)
  const editorRef = useRef<CodeMirrorEditorHandle | null>(null)

  const docKey = document ? `${document.docKey}#${revision}` : null
  const stored = document ? storedDrafts[document.docKey] : undefined
  const draft = stored?.kind === 'css' ? stored : undefined
  const status: PanelStatus =
    scopedStatus && scopedStatus.docKey === docKey
      ? scopedStatus.status
      : draft
        ? { kind: 'syntax', count: draft.syntaxErrorCount }
        : { kind: 'idle' }
  const setStatus = (next: PanelStatus) => {
    if (docKey !== null) setScopedStatus({ docKey, status: next })
  }

  const onChange = (text: string, info: EditorChangeInfo) => {
    if (!document) return
    if (info.syntaxErrorCount > 0) {
      setStatus({ kind: 'syntax', count: info.syntaxErrorCount })
      setCodeDockDraft(document.docKey, { kind: 'css', text, syntaxErrorCount: info.syntaxErrorCount })
      return
    }
    if (draft) setCodeDockDraft(document.docKey, null)
    const plan = planStylesheetEdit({ text, projection: document.projection, breakpoints: document.breakpoints })
    const result = runOwnWrite(() => applyStylesheetEdit(plan.edit))
    const blocked = [...new Set([...plan.blockedSelectors, ...result.blockedSelectors])]
    if (blocked.length > 0) setStatus({ kind: 'blocked', selectors: blocked })
    else if (plan.warnings.length > 0) setStatus({ kind: 'warning', message: plan.warnings[0] })
    else setStatus({ kind: 'idle' })
  }

  if (!document || docKey === null || !inputs.site) {
    return <p className={styles.empty}>Open a page to edit its CSS.</p>
  }

  const completions = deriveCssCompletionCatalog(inputs.site)

  return (
    <div className={styles.panel} data-testid="css-panel">
      <div className={styles.toolbar}>
        <span
          className={cn(
            styles.toolbarNote,
            (status.kind === 'syntax' || status.kind === 'blocked') && styles.statusError,
            status.kind === 'warning' && styles.statusWarning,
          )}
          role="status"
          data-testid="css-panel-status"
          data-status={status.kind}
        >
          {statusText(status)}
        </span>
        <span className={styles.toolbarActions}>
          <FormatButton onFormat={() => void editorRef.current?.format()} testId="css-panel-format" />
        </span>
      </div>
      <div className={styles.editor}>
        <Suspense fallback={<div className={styles.loading}>Loading editor</div>}>
          <CodeMirrorEditor
            ref={editorRef}
            docKey={docKey}
            value={draft?.text ?? document.projection.text}
            language="css"
            changeDelayMs={CSS_PANEL_APPLY_DELAY_MS}
            lintSyntax
            lintGutter={false}
            lockedRanges={document.projection.blocks.filter((block) => block.locked)}
            completions={completions}
            onChange={onChange}
            onFormatError={(message) => pushToast({ kind: 'error', title: 'Could not format the CSS', body: message })}
          />
        </Suspense>
      </div>
    </div>
  )
}
