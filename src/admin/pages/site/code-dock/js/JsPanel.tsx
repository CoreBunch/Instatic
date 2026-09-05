/**
 * JsPanel — the Code Dock's JS column: edits the current page's script
 * (docs/features/god-mode.md → "JS panel").
 *
 * The page script is an ordinary script code asset scoped to exactly this
 * page (`findPageScript`), created lazily on the first edit
 * (`createPageScript`: file + page scope in one undo step) and saved
 * live-debounced through the file slice like the Code editor panel does. It
 * rides the existing build/inject pipeline, so it runs in the canvas and on
 * the published page, and it stays editable in the Explorer Code tab. The
 * panel follows the active page, never the element selection.
 */
import { lazy, Suspense, useDeferredValue, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { findPageScript, pageScriptPath } from '@core/site-runtime'
import type { SiteFile } from '@core/files/schemas'
import type { Page, SiteDocument } from '@core/page-tree'
import { useEditorStore } from '@site/store/store'
import type { EditorStore } from '@site/store/types'
import { fileLanguage } from '@site/code-editor/fileLanguage'
import type { CodeMirrorEditorHandle } from '@site/code-editor/CodeMirrorEditor'
import { pushToast } from '@ui/components/Toast'
import {
  fileRuntimeDiagnostics,
  type RuntimeScriptValidationState,
} from '@site/hooks/useRuntimeScriptDiagnostics'
import { cn } from '@ui/cn'
import { useDocumentSync, type DocumentSyncSource } from '../useDocumentSync'
import { deriveJsCompletionCatalog } from '../completions'
import { FormatButton } from '../FormatButton'
import styles from '../EditorColumn.module.css'

const CodeMirrorEditor = lazy(() => import('@site/code-editor/CodeMirrorEditor'))

/** Live-save debounce; matches the Code editor panel's feel. */
export const JS_PANEL_SAVE_DELAY_MS = 250

type JsPanelInputs = Pick<EditorStore, 'site' | 'siteRuntime' | 'activePageId' | 'activeDocument'>

const selectInputs = (s: JsPanelInputs): JsPanelInputs => ({
  site: s.site,
  siteRuntime: s.siteRuntime,
  activePageId: s.activePageId,
  activeDocument: s.activeDocument,
})

interface PageScriptTarget {
  site: SiteDocument
  page: Page
  file: SiteFile | null
}

/** The page whose script the panel edits: the page canvas, never a VC definition. */
function resolveTarget(inputs: JsPanelInputs): PageScriptTarget | null {
  const { site, siteRuntime, activePageId, activeDocument } = inputs
  if (!site || !activePageId || activeDocument?.kind === 'visualComponent') return null
  const page = site.pages.find((p) => p.id === activePageId)
  if (!page) return null
  return { site, page, file: findPageScript(site.files, siteRuntime, page.id) }
}

const syncSource: DocumentSyncSource<JsPanelInputs> = {
  select: selectInputs,
  equal: (a, b) =>
    a.site === b.site
    && a.siteRuntime === b.siteRuntime
    && a.activePageId === b.activePageId
    && a.activeDocument === b.activeDocument,
  read: (inputs) => {
    const target = resolveTarget(inputs)
    return target ? { docKey: `js:page:${target.page.id}`, text: target.file?.content ?? '' } : null
  },
}

export function JsPanel({ runtimeValidation }: { runtimeValidation?: RuntimeScriptValidationState }) {
  const inputs = useDeferredValue(useEditorStore(useShallow(selectInputs)))
  const createPageScript = useEditorStore((s) => s.createPageScript)
  const updateFileContent = useEditorStore((s) => s.updateFileContent)
  // The selection only shapes completions (the selected element's classes
  // and id first); the edited document never changes with it.
  const selectedNodeId = useEditorStore((s) => s.selectedNodeId)
  const { revision, runOwnWrite } = useDocumentSync(syncSource)
  const editorRef = useRef<CodeMirrorEditorHandle | null>(null)
  const target = resolveTarget(inputs)

  if (!target) {
    return <p className={styles.empty}>Open a page to edit its script.</p>
  }

  const { site, page, file } = target
  const path = file?.path ?? pageScriptPath(site.files, page)
  const completions = deriveJsCompletionCatalog({ site, tree: page, selectedNodeId })
  const diagnostics = file ? fileRuntimeDiagnostics(runtimeValidation?.diagnostics ?? [], file) : []
  const errorCount = diagnostics.filter((d) => d.severity === 'error').length

  const onChange = (content: string) => {
    runOwnWrite(() => {
      if (file) {
        updateFileContent(file.id, content)
      } else if (content.length > 0) {
        // Lazy: the asset exists from the first real edit, never before.
        createPageScript(page.id, content)
      }
    })
  }

  return (
    <div className={styles.panel} data-testid="js-panel">
      <div className={styles.toolbar}>
        <span
          className={cn(styles.toolbarNote, errorCount > 0 && styles.statusError)}
          role="status"
          data-testid="js-panel-status"
        >
          {path} · runs on this page only
          {file ? '' : ' · created on first edit'}
          {errorCount > 0 ? ` · ${errorCount} error${errorCount === 1 ? '' : 's'}` : ''}
        </span>
        <span className={styles.toolbarActions}>
          <FormatButton onFormat={() => void editorRef.current?.format()} testId="js-panel-format" />
        </span>
      </div>
      <div className={styles.editor}>
        <Suspense fallback={<div className={styles.loading}>Loading editor</div>}>
          <CodeMirrorEditor
            ref={editorRef}
            docKey={`js:page:${page.id}#${revision}`}
            value={file?.content ?? ''}
            language={file ? fileLanguage(file) : 'javascript'}
            changeDelayMs={JS_PANEL_SAVE_DELAY_MS}
            lintGutter={false}
            diagnostics={diagnostics}
            filePath={file?.path}
            projectFiles={file ? site.files : undefined}
            completions={completions}
            onChange={onChange}
            onFormatError={(message) => pushToast({ kind: 'error', title: 'Could not format the script', body: message })}
          />
        </Suspense>
      </div>
    </div>
  )
}
