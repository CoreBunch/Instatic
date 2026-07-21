/**
 * ImportHtmlModal — paste raw HTML and insert it as page nodes.
 *
 * Reads modal state (open/parentId/prefill) from the editor store so it can
 * be opened from the Spotlight command, the canvas context menu, and the DOM
 * panel context menu via a single `openImportHtmlModal()` call.
 *
 * AdminCanvasEditorBody lazy-loads this component when `importHtmlModalOpen`
 * flips true. The component mounts fresh on each open. All local state is
 * initialized from store values once on mount; no reset effects are needed.
 *
 * Pipeline on "Insert":
 *   1. `importHtml(source)` — parse → harvest inline styles + <style> CSS →
 *      strip unsafe → walk and map to PageNodes
 *   2. `cssToStyleRules(styleCss)` — parse <style> blocks into registry rules
 *   3. `insertImportedNodes(parentId, fragment, { styleRules, conditions })` —
 *      nodes + <style> rules in a single undo step
 *   4. `pushToast` — success summary (added selectors + stripped-counts detail)
 *
 * The live preview debounces at 200 ms so typing feels instant.
 */

import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Dialog } from '@ui/components/Dialog'
import { Button } from '@ui/components/Button'
import { pushToast } from '@ui/components/Toast'
import { importHtml, type ImportFragment, type ImportResult } from '@core/htmlImport'
import { cssToStyleRules } from '@core/siteImport'
import { useEditorStore, selectActiveCanvasPage } from '@site/store/store'
import { getNodeDisplayName, getNodeHtmlTag } from '@core/page-tree'
import type { PageNode } from '@core/page-tree'
import { TreeContainer, TreeRow } from '@site/ui/Tree'
import { useEditorPreference } from '@site/preferences/editorPreferences'
import { useModuleDefinition } from '@site/useModuleRegistry'
import { LayerTreeNodeContent } from '@site/panels/DomPanel'
import styles from './ImportHtmlModal.module.css'
import { getErrorMessage } from '@core/utils/errorMessage'

const CodeMirrorEditor = lazy(() => import('@site/code-editor/CodeMirrorEditor'))

// ---------------------------------------------------------------------------
// Fragment preview — recursive read-only Layers-style tree
// ---------------------------------------------------------------------------

interface PreviewNodeRowProps {
  nodeId: string
  nodes: Record<string, PageNode>
  depth: number
  showIcon: boolean
  showTag: boolean
  showClasses: boolean
}

function PreviewNodeRow({
  nodeId,
  nodes,
  depth,
  showIcon,
  showTag,
  showClasses,
}: PreviewNodeRowProps) {
  const node = nodes[nodeId]
  const [expanded, setExpanded] = useState(true)
  // Registry-reactive lookup (hook precedes the null guard — hooks order).
  // See `useModuleRegistry.ts` for why this must come from the snapshot.
  const definition = useModuleDefinition(node?.moduleId)
  if (!node) return null

  const displayName = getNodeDisplayName(node, definition, undefined)
  const htmlTag = getNodeHtmlTag(node, definition)
  const hasChildren = node.children.length > 0
  const classSelectorChip = node.classIds.length > 0 ? `.${node.classIds.join('.')}` : null

  function toggleExpanded() {
    if (hasChildren) setExpanded((current) => !current)
  }

  return (
    <div data-node-id={nodeId}>
      <TreeRow
        depth={depth}
        role="treeitem"
        aria-selected={false}
        aria-expanded={hasChildren ? expanded : undefined}
        aria-label={displayName}
        tabIndex={0}
        onClick={toggleExpanded}
        onKeyDown={(event) => {
          if (!hasChildren) return
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            toggleExpanded()
          }
          if (event.key === 'ArrowRight' && !expanded) {
            event.preventDefault()
            setExpanded(true)
          }
          if (event.key === 'ArrowLeft' && expanded) {
            event.preventDefault()
            setExpanded(false)
          }
        }}
      >
        <LayerTreeNodeContent
          moduleId={node.moduleId}
          displayName={displayName}
          htmlTag={htmlTag}
          classSelectorChip={classSelectorChip}
          hasChildren={hasChildren}
          expanded={expanded}
          showIcon={showIcon}
          showTag={showTag}
          showClasses={showClasses}
          locked={node.locked}
          hidden={node.hidden}
          onToggle={(event) => {
            event.stopPropagation()
            toggleExpanded()
          }}
        />
      </TreeRow>
      {hasChildren && expanded && (
        <div role="group">
          {node.children.map((childId) => (
            <PreviewNodeRow
              key={childId}
              nodeId={childId}
              nodes={nodes}
              depth={depth + 1}
              showIcon={showIcon}
              showTag={showTag}
              showClasses={showClasses}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function parseImportPreview(source: string): ImportResult | null {
  if (!source.trim()) return null
  try {
    return importHtml(source)
  } catch (_err) {
    // Invalid preview HTML should not block typing; Insert reparses and reports errors.
    return null
  }
}

interface FragmentPreviewProps {
  result: ImportResult | null
  showIcon: boolean
  showTag: boolean
  showClasses: boolean
}

function FragmentPreview({ result, showIcon, showTag, showClasses }: FragmentPreviewProps) {
  if (!result || result.rootIds.length === 0) {
    return (
      <p className={styles.previewEmpty}>
        No imported nodes
      </p>
    )
  }

  const total = Object.keys(result.nodes).length
  return (
    <>
      <div className={styles.previewSummary}>
        {total} {total === 1 ? 'node' : 'nodes'}
      </div>
      <TreeContainer
        ariaLabel="Imported node preview"
        testId="import-html-preview-tree"
        className={styles.previewTree}
      >
        {result.rootIds.map((id) => (
          <PreviewNodeRow
            key={id}
            nodeId={id}
            nodes={result.nodes}
            depth={0}
            showIcon={showIcon}
            showTag={showTag}
            showClasses={showClasses}
          />
        ))}
      </TreeContainer>
    </>
  )
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

/**
 * ImportHtmlModal is lazy-mounted conditionally from AdminCanvasEditorBody:
 *   `{importHtmlModalOpen && <Suspense><ImportHtmlModal /></Suspense>}`
 *
 * This means the component is always freshly mounted each time the modal
 * opens — no reset effects are needed. Local state is initialized once
 * from the store's snapshot at mount time.
 */
export function ImportHtmlModal() {
  const storeParentId = useEditorStore((s) => s.importHtmlModalParentId)
  const storePrefill = useEditorStore((s) => s.importHtmlModalPrefill)
  const closeModal = useEditorStore((s) => s.closeImportHtmlModal)
  const insertImportedNodes = useEditorStore((s) => s.insertImportedNodes)
  const breakpoints = useEditorStore((s) => s.site?.breakpoints)
  const canvasPage = useEditorStore(selectActiveCanvasPage)
  const showIcon = useEditorPreference('layersShowIcon')
  const showTag = useEditorPreference('layersShowTag')
  const showClasses = useEditorPreference('layersShowClasses')

  // Initialize from store values — fresh on every mount.
  const rootId = canvasPage?.rootNodeId ?? ''
  const [html, setHtml] = useState(storePrefill)
  const [result, setResult] = useState<ImportResult | null>(() => parseImportPreview(storePrefill))
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const targetParentId = storeParentId ?? rootId

  // Live preview — debounced 200 ms. All setState calls inside the timer
  // callback (not synchronously in the effect body).
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      setResult(parseImportPreview(html))
    }, 200)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [html])

  const nodeCount = result ? Object.keys(result.nodes).length : 0
  const canInsert = nodeCount > 0

  const handleInsert = () => {
    if (!canInsert || !result) return
    if (!targetParentId) return

    try {
      // Parse any <style> CSS into registry rules using the site's breakpoints
      // so @media folds into the matching breakpoint's contextStyles.
      const bpHints = (breakpoints ?? []).map((b) => ({
        id: b.id,
        width: b.width,
        mediaQuery: b.mediaQuery,
      }))
      const { rules, conditions } = result.styleCss.trim()
        ? cssToStyleRules(result.styleCss, { breakpoints: bpHints })
        : { rules: [], conditions: [] }

      const fragment: ImportFragment = { nodes: result.nodes, rootIds: result.rootIds }
      const inserted = insertImportedNodes(targetParentId, fragment, {
        styleRules: rules,
        conditions,
      })
      if (inserted.length === 0) {
        setErrorMsg('The selected parent does not accept children.')
        return
      }

      // Build toast body: node count + added-selector / stripped detail.
      const toastTitle = `Imported ${inserted.length} ${inserted.length === 1 ? 'node' : 'nodes'}`
      const detailParts: string[] = []
      if (rules.length) {
        detailParts.push(`${rules.length} CSS selector${rules.length > 1 ? 's' : ''}`)
      }
      const { stripped } = result
      if (stripped.scripts) detailParts.push(`stripped ${stripped.scripts} <script>`)
      if (stripped.inlineHandlers) {
        detailParts.push(`stripped ${stripped.inlineHandlers} inline handler${stripped.inlineHandlers > 1 ? 's' : ''}`)
      }
      const toastBody = detailParts.length > 0 ? detailParts.join(', ') : undefined

      pushToast({ kind: 'success', title: toastTitle, body: toastBody })
      closeModal()
    } catch (err) {
      console.error('[ImportHtmlModal] insert failed:', err)
      setErrorMsg(getErrorMessage(err, 'Unknown import error'))
    }
  }

  return (
    <Dialog
      open={true}
      onClose={closeModal}
      title="Import HTML"
      eyebrow="Instatic"
      size="lg"
      className={styles.dialog}
      bodyClassName={styles.dialogBody}
      footer={
        <>
          <Button variant="secondary" type="button" onClick={closeModal}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="button"
            onClick={handleInsert}
            disabled={!canInsert}
          >
            Insert
          </Button>
        </>
      }
    >
      <div className={styles.columns}>
        <section className={styles.editorColumn} aria-label="HTML source">
          <div className={styles.columnHeader}>
            <h3 className={styles.columnTitle}>HTML</h3>
            {errorMsg && (
              <div className={styles.errorAlert} role="alert">
                {errorMsg}
              </div>
            )}
          </div>
          <div
            className={styles.codeEditor}
            data-testid="import-html-code-editor"
          >
            <Suspense fallback={<div className={styles.editorLoading}>Loading editor</div>}>
              <CodeMirrorEditor
                docKey="import-html"
                value={html}
                language="html"
                changeDelayMs={0}
                onChange={(nextHtml) => {
                  setHtml(nextHtml)
                  setErrorMsg(null)
                }}
              />
            </Suspense>
          </div>
        </section>

        <section className={styles.previewColumn} aria-label="Tree preview">
          <div className={styles.columnHeader}>
            <h3 className={styles.columnTitle}>Tree preview</h3>
          </div>
          <div className={styles.previewScroll}>
            <FragmentPreview
              result={result}
              showIcon={showIcon}
              showTag={showTag}
              showClasses={showClasses}
            />
          </div>
        </section>
      </div>
    </Dialog>
  )
}
