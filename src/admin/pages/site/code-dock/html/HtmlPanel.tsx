/**
 * HtmlPanel — the Code Dock's HTML column: the editable projection of the
 * current selection (or the whole document), applied back to the tree as
 * you type (docs/features/god-mode.md → "HTML panel").
 *
 * Read side: `deriveHtmlPanelDocument` renders the scoped subtree in the
 * projection dialect, reflowed for reading. Write side: every debounced
 * change that parses runs the uid-preserving `importProjectionHtml` and,
 * when the result is harmless, `applyProjectionImport` at once — one flush,
 * one tree-undo step, canvas and layer panel repaint. The buffer is then
 * brought up to the fresh projection IN PLACE (`syncValue`: new uids, the
 * canonical reflow) so the caret never jumps. Nothing touches the tree
 * while the document has syntax errors, and never in the read-only view of
 * a Component instance's internals (those jump to the definition).
 *
 * Two kinds of change are HELD instead of applied, and go through the
 * explicit Apply (button or Mod-Enter) with a confirm dialog:
 *
 *   - DESTRUCTIVE: the import's diff removes locked nodes or Component/slot
 *     structures — summarised by `summarizeDestructiveApply` and confirmed
 *     before anything mutates. The confirm is re-validated when accepted:
 *     if the tree moved while the dialog was open, the dialog shows the new
 *     summary instead of committing.
 *   - STALE: the projection for a dirty scope no longer matches the draft's
 *     baseline — a co-editor, an agent, or a tree undo changed the subtree.
 *     The draft and its buffer stay verbatim (`holdRemounts`), a banner says
 *     so, and Apply becomes overwrite-with-confirm. The only ways out are
 *     explicit: apply over it, or discard the draft.
 *
 * Unapplied drafts (held, stale, or not parsing) are kept per scope in the
 * store (`codeDockDrafts`, bounded, oldest first out): switching selection
 * keeps them, switching back restores them, and they outlive the panel
 * itself (expanding into the dialog, the tab fallback). An ORPHANED draft —
 * its element was removed remotely or by a canvas undo — is named in a
 * banner with its text one click from the clipboard, never lost silently.
 *
 * The panel is also an INSPECTOR (reverse selection sync): the editor
 * reports the `uid` under the cursor (`onCursorUid`) and the panel hovers
 * that node — canvas hover ring, layer-panel highlight — and shows its
 * ancestry as breadcrumbs (click one to select that ancestor); a click on a
 * tag name (`onTagClick`) selects the node. The read-only view is inert.
 * Focus stays in the editor throughout.
 */
import { lazy, Suspense, useDeferredValue, useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { importProjectionHtml, type ProjectionImportResult } from '@core/htmlImport'
import { registry } from '@core/module-engine'
import { getAncestors, getNodeDisplayName, type NodeTree, type PageNode } from '@core/page-tree'
import { getErrorMessage } from '@core/utils/errorMessage'
import { useEditorStore } from '@site/store/store'
import type { EditorStore } from '@site/store/types'
import type { HtmlDraftHold, HtmlPanelDraft } from '@site/store/slices/codeDockDrafts'
import { formatShortcut, getKeybindingForCommand } from '@admin/spotlight/keybindings'
import type { CodeMirrorEditorHandle, EditorChangeInfo } from '@site/code-editor/CodeMirrorEditor'
import { Button } from '@ui/components/Button'
import { ChevronRightIcon } from 'pixel-art-icons/icons/chevron-right'
import { pushToast } from '@ui/components/Toast'
import { cn } from '@ui/cn'
import { useDocumentSync, type DocumentSyncSource } from '../useDocumentSync'
import { deriveHtmlCompletionCatalog, useDataMeta } from '../completions'
import { FormatButton } from '../FormatButton'
import { deriveHtmlPanelDocument, type HtmlPanelDocument } from './htmlPanelDocument'
import { summarizeDestructiveApply, type DestructiveRemoval } from './applyGuardrails'
import { HtmlApplyConfirmDialog } from './HtmlApplyConfirmDialog'
import { selectSelectionScope, selectionScopeEqual, type SelectionScopeInputs } from '../selectionScope'
import styles from '../EditorColumn.module.css'

const CodeMirrorEditor = lazy(() => import('@site/code-editor/CodeMirrorEditor'))

const APPLY_SHORTCUT = formatShortcut(getKeybindingForCommand('godMode.applyHtml')!.shortcut)

/** Live-apply debounce: long enough to coalesce a burst of typing into one undo step. */
export const HTML_PANEL_APPLY_DELAY_MS = 300

const syncSource: DocumentSyncSource<SelectionScopeInputs> = {
  select: selectSelectionScope,
  equal: selectionScopeEqual,
  read: (inputs) => {
    const next = deriveHtmlPanelDocument(inputs)
    return next ? { docKey: next.docKey, text: next.html } : null
  },
}

interface AppliedReport {
  docKey: string
  /** The projection the apply produced — the report is shown while it lasts. */
  html: string
  created: number
  patched: number
  deleted: number
}

type PanelStatus =
  | { kind: 'read-only' }
  | { kind: 'syntax'; count: number }
  | { kind: 'stale' }
  | { kind: 'held'; hold: HtmlDraftHold }
  | { kind: 'dirty' }
  | { kind: 'clean'; applied: AppliedReport | null }

function statusText(status: PanelStatus): string {
  switch (status.kind) {
    case 'read-only':
      return 'Component instance — read-only here'
    case 'syntax':
      return `${status.count} syntax error${status.count === 1 ? '' : 's'} — not applied`
    case 'stale':
      return 'Draft is out of date — Apply overwrites'
    case 'held':
      return status.hold.kind === 'error'
        ? `Not applied: ${status.hold.message}`
        : `Removes ${describeRemovals(status.hold.removals)} — Apply (${APPLY_SHORTCUT}) asks you to confirm`
    case 'dirty':
      return 'Applying…'
    case 'clean':
      return status.applied ? describeApply(status.applied) : 'Live · edits apply as you type'
  }
}

function describeRemovals(removals: DestructiveRemoval[]): string {
  const first = removals[0]
  const rest = removals.length - 1
  return rest > 0 ? `“${first.name}” and ${rest} more` : `“${first.name}”`
}

function describeApply(report: AppliedReport): string {
  const parts = [
    report.patched > 0 ? `${report.patched} patched` : null,
    report.created > 0 ? `${report.created} created` : null,
    report.deleted > 0 ? `${report.deleted} deleted` : null,
  ].filter((part): part is string => part !== null)
  return parts.length > 0 ? `Applied · ${parts.join(' · ')}` : 'Applied · no changes'
}

/** What an apply held for confirmation would do — compared on re-validation. */
interface PendingApply {
  stale: boolean
  removals: DestructiveRemoval[]
}

function pendingEqual(a: PendingApply, b: PendingApply): boolean {
  return (
    a.stale === b.stale
    && a.removals.length === b.removals.length
    && a.removals.every((removal, i) => removal.id === b.removals[i].id && removal.retyped === b.removals[i].retyped)
  )
}

function nodeName(node: PageNode, site: NonNullable<EditorStore['site']>): string {
  return getNodeDisplayName(node, registry.get(node.moduleId), site.visualComponents)
}

function scopeName(document: HtmlPanelDocument, site: NonNullable<EditorStore['site']>): string {
  const node = document.tree.nodes[document.rootId]
  return node ? nodeName(node, site) : document.rootId
}

function nodeExistsInSite(site: NonNullable<EditorStore['site']>, nodeId: string): boolean {
  return site.pages.some((page) => nodeId in page.nodes) || site.visualComponents.some((vc) => nodeId in vc.tree.nodes)
}

/** The cursor's node and its ancestors, root first — the breadcrumb trail. */
function breadcrumbTrail(tree: NodeTree<PageNode>, nodeId: string): PageNode[] {
  const node = tree.nodes[nodeId]
  return node ? [...getAncestors(tree, nodeId), node] : []
}

export function HtmlPanel() {
  // Deferred: during a burst of store changes (a collab load, an agent
  // batch) the expensive projection is derived once the burst settles.
  const inputs = useDeferredValue(useEditorStore(useShallow(selectSelectionScope)))
  const applyProjectionImport = useEditorStore((s) => s.applyProjectionImport)
  const setActiveDocument = useEditorStore((s) => s.setActiveDocument)
  const hoverNode = useEditorStore((s) => s.hoverNode)
  const selectNode = useEditorStore((s) => s.selectNode)
  const setCodeDockDraft = useEditorStore((s) => s.setCodeDockDraft)
  // Unapplied edits, per scope, from the store: switching selection or
  // remounting the panel never discards them.
  const storedDrafts = useEditorStore((s) => s.codeDockDrafts)
  const document = deriveHtmlPanelDocument(inputs)
  const drafts: Record<string, HtmlPanelDraft> = {}
  for (const [key, stored] of Object.entries(storedDrafts)) {
    if (stored.kind === 'html') drafts[key] = stored
  }
  const scopeDraft = document ? drafts[document.docKey] : undefined
  const scopeDirty = scopeDraft !== undefined && scopeDraft.text !== document?.html
  // A dirty scope keeps its buffer (caret, history) through every store
  // change, including the remote ones the stale banner reports.
  const { revision, runOwnWrite } = useDocumentSync(syncSource, { holdRemounts: scopeDirty })
  const [applied, setApplied] = useState<AppliedReport | null>(null)
  const [pending, setPending] = useState<PendingApply | null>(null)
  // The element under the cursor, for the breadcrumbs — remembered with its
  // scope so a scope change never shows a trail from another document.
  const [cursor, setCursor] = useState<{ docKey: string; uid: string } | null>(null)
  const editorRef = useRef<CodeMirrorEditorHandle | null>(null)
  const dataMeta = useDataMeta()
  // The node this panel is hover-highlighting from the cursor, so unmounting
  // (leaving God Mode) can drop a highlight nobody else owns.
  const inspectorHoverRef = useRef<string | null>(null)
  useEffect(
    () => () => {
      const hovered = inspectorHoverRef.current
      if (hovered !== null && useEditorStore.getState().hoveredNodeId === hovered) {
        useEditorStore.getState().hoverNode(null)
      }
    },
    [],
  )

  if (!document || !inputs.site) {
    return <p className={styles.empty}>Open a page to edit its HTML.</p>
  }

  const site = inputs.site
  const { docKey, html, rootId, tree, readOnly, definitionVcId } = document
  const activePage =
    inputs.activeDocument?.kind === 'visualComponent'
      ? null
      : site.pages.find((page) => page.id === inputs.activePageId) ?? null
  const completions = deriveHtmlCompletionCatalog({ site, tree, rootId, activePage, dataMeta })
  const draft = scopeDraft
  const dirty = scopeDirty
  const stale = draft !== undefined && dirty && draft.baseHtml !== html
  const syntaxErrorCount = draft?.syntaxErrorCount ?? 0
  const canApply = dirty && syntaxErrorCount === 0 && !readOnly
  const orphaned = Object.entries(drafts).find(([, d]) => !nodeExistsInSite(site, d.rootId)) ?? null
  const trailId = cursor && cursor.docKey === docKey && cursor.uid in tree.nodes ? cursor.uid : rootId
  const trail = breadcrumbTrail(tree, trailId)

  const status: PanelStatus = readOnly
    ? { kind: 'read-only' }
    : syntaxErrorCount > 0
      ? { kind: 'syntax', count: syntaxErrorCount }
      : stale
        ? { kind: 'stale' }
        : dirty && draft?.held
          ? { kind: 'held', hold: draft.held }
          : dirty
            ? { kind: 'dirty' }
            : { kind: 'clean', applied: applied?.docKey === docKey && applied.html === html ? applied : null }

  const dropDraft = (key: string) => setCodeDockDraft(key, null)

  const rememberDraft = (text: string, info: EditorChangeInfo, held: HtmlDraftHold | null) => {
    const previous = drafts[docKey]
    setCodeDockDraft(
      docKey,
      previous
        ? { ...previous, text, syntaxErrorCount: info.syntaxErrorCount, held }
        : { kind: 'html', text, syntaxErrorCount: info.syntaxErrorCount, baseHtml: html, rootId, name: scopeName(document, site), held },
    )
  }

  const importDraft = (text: string): ProjectionImportResult =>
    importProjectionHtml(text, { tree, rootId, styleRules: site.styleRules })

  const summarize = (result: ProjectionImportResult): PendingApply => ({
    stale,
    removals: summarizeDestructiveApply(result.diff, tree, site.visualComponents),
  })

  const REFUSED = 'the store refused the change (the element may be gone, or you are offline)'

  const commit = (result: ProjectionImportResult): boolean => {
    const ok = runOwnWrite(() => applyProjectionImport(result))
    if (!ok) return false
    dropDraft(docKey)
    const fresh = deriveHtmlPanelDocument(selectSelectionScope(useEditorStore.getState()))
    setApplied({
      docKey,
      html: fresh?.html ?? html,
      created: result.diff.createdIds.length,
      patched: result.diff.patchedIds.length,
      deleted: result.diff.deletedIds.length,
    })
    return true
  }

  // Every debounced change: apply live when it parses and is harmless;
  // otherwise remember why it is held, so the status and Apply say so.
  const onChange = (text: string, info: EditorChangeInfo) => {
    if (text === html) {
      if (draft) dropDraft(docKey)
      return
    }
    if (readOnly || info.syntaxErrorCount > 0 || stale) {
      rememberDraft(text, info, null)
      return
    }
    try {
      const result = importDraft(text)
      const removals = summarizeDestructiveApply(result.diff, tree, site.visualComponents)
      if (removals.length > 0) {
        rememberDraft(text, info, { kind: 'destructive', removals })
        return
      }
      // A refused commit keeps the draft, held with the reason, so the
      // status says so instead of a toast per keystroke.
      if (!commit(result)) rememberDraft(text, info, { kind: 'error', message: REFUSED })
    } catch (err) {
      console.error('[HtmlPanel] live apply failed:', err)
      rememberDraft(text, info, { kind: 'error', message: getErrorMessage(err, 'Unknown import error') })
    }
  }

  const reportFailure = (err: unknown) => {
    console.error('[HtmlPanel] apply failed:', err)
    pushToast({ kind: 'error', title: 'Could not apply HTML', body: getErrorMessage(err, 'Unknown import error') })
  }

  const apply = () => {
    if (!canApply || !draft) return
    try {
      const result = importDraft(draft.text)
      const summary = summarize(result)
      if (summary.stale || summary.removals.length > 0) {
        setPending(summary)
        return
      }
      if (!commit(result)) pushToast({ kind: 'error', title: 'Could not apply HTML', body: `Not applied: ${REFUSED}.` })
    } catch (err) {
      reportFailure(err)
    }
  }

  // Confirmed: re-import against the tree as it is NOW. If what the apply
  // would do no longer matches what the dialog showed (the tree moved while
  // it was open), show the new summary instead of committing — a confirm
  // only ever covers the summary the user actually read.
  const confirmPending = () => {
    if (!pending || !canApply || !draft) {
      setPending(null)
      return
    }
    try {
      const result = importDraft(draft.text)
      const summary = summarize(result)
      const harmless = !summary.stale && summary.removals.length === 0
      if (harmless || pendingEqual(pending, summary)) {
        setPending(null)
        if (!commit(result)) pushToast({ kind: 'error', title: 'Could not apply HTML', body: `Not applied: ${REFUSED}.` })
      } else {
        setPending(summary)
      }
    } catch (err) {
      setPending(null)
      reportFailure(err)
    }
  }

  const discardDraft = () => dropDraft(docKey)

  const copyOrphanedDraft = async () => {
    if (!orphaned) return
    try {
      await navigator.clipboard.writeText(orphaned[1].text)
      pushToast({ kind: 'success', title: 'Draft copied', body: `The unapplied HTML for “${orphaned[1].name}” is on the clipboard.` })
    } catch (err) {
      console.error('[HtmlPanel] copy draft failed:', err)
      pushToast({ kind: 'error', title: 'Could not copy the draft', body: getErrorMessage(err, 'Clipboard unavailable') })
    }
  }

  // Reverse selection sync — only uids of the projected tree count; a typed
  // (unapplied) uid, or none, highlights nothing. The read-only view of a
  // Component instance's internals is inert: no highlight, no selection.
  const onCursorUid = (uid: string | null) => {
    const id = !readOnly && uid !== null && uid in tree.nodes ? uid : null
    setCursor(id ? { docKey, uid: id } : null)
    inspectorHoverRef.current = id
    if (useEditorStore.getState().hoveredNodeId !== id) hoverNode(id)
  }

  const onTagClick = (uid: string) => {
    if (!readOnly && uid in tree.nodes && uid !== inputs.selectedNodeId) selectNode(uid)
  }

  const onFormat = () => {
    void editorRef.current?.format()
  }

  const onFormatError = (message: string) => {
    pushToast({ kind: 'error', title: 'Could not format the HTML', body: message })
  }

  return (
    <div className={styles.panel} data-testid="html-panel" data-dirty={dirty ? 'true' : 'false'}>
      <div className={styles.toolbar}>
        <span
          className={cn(
            styles.toolbarNote,
            (status.kind === 'held' || status.kind === 'stale') && styles.dirty,
            status.kind === 'syntax' && styles.statusError,
          )}
          role="status"
          data-testid="html-panel-status"
          data-status={status.kind}
        >
          {statusText(status)}
        </span>
        <span className={styles.toolbarActions}>
          <FormatButton onFormat={onFormat} testId="html-panel-format" />
          {readOnly && definitionVcId ? (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => setActiveDocument({ kind: 'visualComponent', vcId: definitionVcId })}
              data-testid="html-panel-open-definition"
            >
              Open component definition
            </Button>
          ) : (
            <Button
              variant="primary"
              size="xs"
              disabled={!canApply}
              onClick={apply}
              tooltip={`Apply the held edits to the page tree (${APPLY_SHORTCUT})`}
              data-testid="html-panel-apply"
            >
              Apply
            </Button>
          )}
        </span>
      </div>
      <nav className={styles.breadcrumbs} aria-label="Element path" data-testid="html-panel-breadcrumbs">
        {trail.map((node, index) => (
          <span key={node.id} className={styles.toolbarActions}>
            {index > 0 ? <ChevronRightIcon size={10} className={styles.breadcrumbSeparator} aria-hidden="true" /> : null}
            <Button
              variant="ghost"
              size="xs"
              pressed={node.id === inputs.selectedNodeId}
              onClick={() => onTagClick(node.id)}
              tooltip={node.id === inputs.selectedNodeId ? 'Selected element' : `Select ${nodeName(node, site)}`}
              data-testid="html-panel-crumb"
              data-node-id={node.id}
            >
              {nodeName(node, site)}
            </Button>
          </span>
        ))}
      </nav>
      {stale ? (
        <div className={styles.banner} role="alert" data-testid="html-panel-stale">
          <span className={styles.bannerText}>
            Content changed remotely. Your draft is kept; Apply overwrites the remote version.
          </span>
          <Button variant="ghost" size="xs" onClick={discardDraft} data-testid="html-panel-discard">
            Discard draft
          </Button>
        </div>
      ) : null}
      {orphaned ? (
        <div className={styles.banner} role="alert" data-testid="html-panel-orphaned">
          <span className={styles.bannerText}>
            Unapplied edits to “{orphaned[1].name}” cannot be applied: the element was removed.
          </span>
          <span className={styles.bannerActions}>
            <Button variant="ghost" size="xs" onClick={copyOrphanedDraft} data-testid="html-panel-orphan-copy">
              Copy draft
            </Button>
            <Button variant="ghost" size="xs" onClick={() => dropDraft(orphaned[0])} data-testid="html-panel-orphan-dismiss">
              Dismiss
            </Button>
          </span>
        </div>
      ) : null}
      <div className={styles.editor}>
        <Suspense fallback={<div className={styles.loading}>Loading editor</div>}>
          <CodeMirrorEditor
            ref={editorRef}
            docKey={`${docKey}#${revision}`}
            value={draft?.text ?? html}
            language="html"
            changeDelayMs={HTML_PANEL_APPLY_DELAY_MS}
            lintSyntax
            lintGutter={false}
            syncValue
            foldUidAttributes
            readOnly={readOnly}
            completions={completions}
            onChange={onChange}
            onSubmit={apply}
            onCursorUid={onCursorUid}
            onTagClick={onTagClick}
            onFormatError={onFormatError}
          />
        </Suspense>
      </div>
      {pending ? (
        <HtmlApplyConfirmDialog
          stale={pending.stale}
          removals={pending.removals}
          onCancel={() => setPending(null)}
          onConfirm={confirmPending}
        />
      ) : null}
    </div>
  )
}
