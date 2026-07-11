/**
 * CodeEditorPanel — floating code editor panel (Task 432).
 *
 * CodeMirror 6 (@codemirror/view, @codemirror/state, @codemirror/lang-javascript,
 * @codemirror/lang-css, @codemirror/lang-json, @codemirror/lang-markdown) is loaded
 * lazily via React.lazy() to keep the editor startup bundle lean (~150 kB min+gz).
 *
 * Architecture:
 * - Floating panel: shared PanelHeader + useDraggablePanel (Guideline 410).
 * - Panel visibility driven by activeEditorFileId: shown when non-null.
 * - Asset files with image/* MIME: renders ImagePreview instead of CodeMirror.
 * - Non-image assets: renders "Binary file" placeholder (handled in ImagePreview).
 * - Text files (component/script/style/config/doc): lazy-loads CodeMirrorEditor.
 * - Content sync: debounced 250ms to updateFileContent(); flush on file switch.
 * - Script files show runtime settings that feed canvas preview and publishing.
 *
 * Security:
 * - File content treated as plaintext. No dangerouslySetInnerHTML, no eval.
 * - Script execution is delegated to the sandboxed site runtime preview path.
 *
 * Architecture source: Contribution 595 section 3
 * Amendment: Contribution 613 section A.2 — image preview and binary placeholder
 * UX spec: Contributions 611 and 612 — center-stage default, 800x500.
 * Guideline 410 — floating panels must use shared PanelHeader
 * Constraint 402 — no inline styles (except CSS-var panelPositionStyle)
 * Editor chrome stays neutral; CodeMirror syntax uses GitHub Dark-style tokens.
 */

import { Suspense, lazy, useEffect, useRef, type CSSProperties } from 'react'
import { useEditorStore } from '@site/store/store'
import { PanelHeader } from '@admin/shared/PanelHeader'
import { useDraggablePanel } from '@admin/shared/FloatingWindow'
import { ImagePreview } from './ImagePreview'
import { ScriptSettingsPane } from './ScriptSettingsPane'
import { StyleSettingsPane } from './StyleSettingsPane'
import { EmptyState } from '@ui/components/EmptyState'
import { cn } from '@ui/cn'
import type { SiteFile } from '@core/files/schemas'
import type { CodeLanguage } from './CodeMirrorEditor'
import styles from './CodeEditorPanel.module.css'

/** Map a SiteFile to the editor's highlighting language (no CM6 imports here). */
function fileLanguage(file: SiteFile): CodeLanguage {
  switch (file.type) {
    case 'component': return 'tsx'
    case 'script': return 'ts'
    case 'style': return 'css'
    case 'config':
      if (file.path.endsWith('.json')) return 'json'
      if (file.path.endsWith('.ts') || file.path.endsWith('.mts')) return 'ts'
      return 'text'
    case 'doc': return 'markdown'
    default: return 'text'
  }
}

// ---------------------------------------------------------------------------
// Lazy-load CodeMirrorEditor — code-splits the heavy CodeMirror 6 bundle
// so it does not inflate the editor's startup chunk.
// ---------------------------------------------------------------------------
const CodeMirrorEditor = lazy(() => import('./CodeMirrorEditor'))

// Panel dimensions per UX Spec (Contribution 612)
const PANEL_WIDTH = 800

// ---------------------------------------------------------------------------
// CodeEditorPanel
// ---------------------------------------------------------------------------

/**
 * Floating CodeEditor panel — always mounted, CSS display:none when no active file.
 * This preserves useDraggablePanel position state across open/close cycles.
 *
 * The panel chrome (~9 kB) lives in the eager admin bundle. The CodeMirror 6
 * bundle (~600 kB) sits behind a single `React.lazy` boundary further down,
 * so we only pay for it the first time the user opens a text file.
 */
export function CodeEditorPanel() {
  // ── Store subscriptions ──────────────────────────────────────────────────
  const activeEditorFileId = useEditorStore((s) => s.activeEditorFileId)
  const activeCodeBuffer = useEditorStore((s) => s.activeCodeBuffer)
  const codeEditorPanelOpen = useEditorStore((s) => s.codeEditorPanelOpen)
  const site = useEditorStore((s) => s.site)
  const closeEditor = useEditorStore((s) => s.closeEditor)
  const updateFileContent = useEditorStore((s) => s.updateFileContent)
  const updateNodeProps = useEditorStore((s) => s.updateNodeProps)

  // Find the active file (null when no file is open or loading site)
  const activeFile = activeEditorFileId && site
    ? (site.files.find((f) => f.id === activeEditorFileId) ?? null)
    : null

  // Current value of the active node-prop buffer (read live so the editor
  // mounts with the node's markup). Looked up in the active page tree.
  const bufferValue = useEditorStore((s) => {
    const buf = s.activeCodeBuffer
    if (!buf || !s.site) return ''
    const page = s.site.pages.find((p) => p.id === s.activePageId)
    const v = page?.nodes[buf.nodeId]?.props?.[buf.propKey]
    return typeof v === 'string' ? v : ''
  })

  // ── Draggable panel position ─────────────────────────────────────────────
  // Default: center-stage per UX Spec (Contribution 612 §4)
  //   x = Math.max(220, (window.innerWidth - 800) / 2)  — avoid dom panel overlap
  //   y = 80
  // Position is persisted by useDraggablePanel in the unified editor layout.
  const { panelRef, setPanelRef, headerDragProps, panelPositionStyle } = useDraggablePanel(
    'codeeditor',
    () => ({
      x: typeof window !== 'undefined'
        ? Math.max(220, (window.innerWidth - PANEL_WIDTH) / 2)
        : 220,
      y: 80,
    }),
  )

  // ── Focus management (WCAG 2.4.3) ───────────────────────────────────────
  // When activeEditorFileId transitions null → non-null, move focus into the
  // panel so keyboard users don't get stranded on the toolbar button. Uses
  // requestAnimationFrame to let CSS display:flex settle before focusing.
  //
  // `panelRef` is a stable ref identity (React guarantees) — listing it in
  // deps is a no-op but satisfies exhaustive-deps without an opt-out.
  const activeDocKey = activeEditorFileId ?? (activeCodeBuffer ? `prop:${activeCodeBuffer.nodeId}:${activeCodeBuffer.propKey}` : null)
  const prevFileIdRef = useRef<string | null>(null)
  useEffect(() => {
    const prev = prevFileIdRef.current
    prevFileIdRef.current = activeDocKey
    if (prev === null && activeDocKey !== null && codeEditorPanelOpen) {
      const handle = requestAnimationFrame(() => {
        const panel = panelRef.current
        if (!panel) return
        // Don't steal focus if the user has already clicked into the
        // panel — the deferred rAF would otherwise yank focus away from
        // an element they just chose. (Same race we guard against in
        // `useAutoFocusPanel` for the docked sidebar panels.)
        if (panel.contains(document.activeElement)) return
        panel.focus()
      })
      return () => cancelAnimationFrame(handle)
    }
    return undefined
  }, [activeDocKey, codeEditorPanelOpen, panelRef])

  // ── Determine content mode ───────────────────────────────────────────────
  // A node-prop buffer (e.g. inline SVG) takes precedence; otherwise:
  // image asset → ImagePreview; non-image asset → placeholder; text file →
  // CodeMirrorEditor (lazy).
  const isAsset = activeFile?.type === 'asset'
  const isImageAsset = isAsset && (activeFile?.blob?.mimeType.startsWith('image/') ?? false)
  const isNonImageAsset = isAsset && !isImageAsset
  const isTextFile = activeFile && !isAsset
  const isScriptFile = activeFile?.type === 'script'
  const isStyleFile = activeFile?.type === 'style'

  // Editor props for the active document — either a node-prop buffer or a file.
  const editorDoc = activeCodeBuffer
    ? {
        docKey: `prop:${activeCodeBuffer.nodeId}:${activeCodeBuffer.propKey}`,
        value: bufferValue,
        language: activeCodeBuffer.language,
        onChange: (content: string) =>
          updateNodeProps(activeCodeBuffer.nodeId, { [activeCodeBuffer.propKey]: content }),
      }
    : activeFile && isTextFile
      ? {
          docKey: activeFile.id,
          value: activeFile.content ?? '',
          language: fileLanguage(activeFile),
          onChange: (content: string) => updateFileContent(activeFile.id, content),
        }
      : null

  // Panel title: buffer title, else filename.
  const panelTitle = activeCodeBuffer
    ? activeCodeBuffer.title
    : activeFile
      ? (activeFile.path.split('/').pop() ?? 'Code Editor')
      : 'Code Editor'
  const hasActivePreview = Boolean(activeFile) || Boolean(activeCodeBuffer)

  return (
    <aside
      ref={setPanelRef}
      role="complementary"
      aria-label="Code Editor"
      data-panel="code-editor"
      tabIndex={-1}
      onClick={(e) => e.stopPropagation()}
      // panelPositionStyle injects --panel-x / --panel-y CSS vars (whitelisted)
      style={panelPositionStyle}
      className={cn(styles.panel, (!hasActivePreview || !codeEditorPanelOpen) && styles.panelHidden)}
    >
      <div className={styles.inner}>
        {/* ── Shared Panel Header ──────────────────────────────────────────── */}
        <PanelHeader
          panelId="code-editor"
          title={panelTitle}
          onClose={closeEditor}
          dragHandleProps={headerDragProps}
        />

        {/* ── Editor body ─────────────────────────────────────────────────── */}
        <div className={styles.editorBody}>
          {!hasActivePreview ? (
            /* Nothing open — show empty state */
            <EmptyState
              variant="centered"
              title="Select a file to edit"
              description="Click any file in the Files panel to open it here."
            />

          ) : activeFile && (isImageAsset || isNonImageAsset) ? (
            /* Asset file — ImagePreview handles both image and binary cases */
            <ImagePreview file={activeFile} />

          ) : editorDoc ? (
            /* Text file OR node-prop buffer — lazy-load the CodeMirror 6 bundle */
            <div className={styles.editorWorkspace}>
              {isScriptFile && activeFile && <ScriptSettingsPane file={activeFile} />}
              {isStyleFile && activeFile && <StyleSettingsPane file={activeFile} />}
              <div className={styles.editorSurface}>
                <Suspense fallback={<CodeEditorSkeleton />}>
                  <CodeMirrorEditor
                    docKey={editorDoc.docKey}
                    value={editorDoc.value}
                    language={editorDoc.language}
                    onChange={editorDoc.onChange}
                  />
                </Suspense>
              </div>
            </div>

          ) : null}
        </div>
      </div>
    </aside>
  )
}

// ---------------------------------------------------------------------------
// CodeEditorSkeleton
//
// Suspense fallback rendered while the CodeMirror 6 chunk is downloading.
// Mimics the editor's gutter + code-line layout so the panel transitions
// smoothly from skeleton → real editor instead of popping from a blank
// surface. CSS shimmer is achromatic and respects prefers-reduced-motion.
// ---------------------------------------------------------------------------

// Stable per-line widths so the skeleton doesn't visually thrash between
// renders. 30–95% covers the natural spread of code-line widths. Passed in
// as a CSS custom property — inline width:'%' would violate Constraint #402
// (no inline style except dynamic CSS variables).
type SkeletonLineStyle = CSSProperties & { '--skeleton-line-width': string }

const SKELETON_LINE_WIDTHS = [
  '72%', '54%', '88%', '40%', '66%', '78%', '48%', '92%', '60%', '34%',
  '82%', '58%',
] as const

export function CodeEditorSkeleton() {
  return (
    <div className={styles.loadingSkeleton} aria-hidden="true">
      <div className={styles.loadingGutter}>
        {SKELETON_LINE_WIDTHS.map((_, index) => (
          <span key={index} className={styles.loadingGutterLine} />
        ))}
      </div>
      <div className={styles.loadingLines}>
        {SKELETON_LINE_WIDTHS.map((width, index) => (
          <span
            key={index}
            className={styles.loadingLine}
            style={{ '--skeleton-line-width': width } as SkeletonLineStyle}
          />
        ))}
      </div>
      <span className={styles.loadingSrOnly} role="status">
        Loading code editor…
      </span>
    </div>
  )
}
