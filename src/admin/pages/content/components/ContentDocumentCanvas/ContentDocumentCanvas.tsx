import { forwardRef, lazy, Suspense, useLayoutEffect, useRef, type KeyboardEvent, type Ref } from 'react'
import { Button } from '@ui/components/Button'
import { Textarea } from '@ui/components/Input'
import { SkeletonBlock } from '@ui/components/Skeleton'
import { cn } from '@ui/cn'
import { FilePlusSolidIcon } from 'pixel-art-icons/icons/file-plus-solid'
import { dataTableHasField } from '@core/data/fields'
import { POST_TYPE_FIELD_BODY } from '@core/data/schemas'
import type { DataTable, DataRow } from '@core/data/schemas'
import { CanvasNotch, type CanvasNotchAction } from '@site/canvas/CanvasNotch'
import canvasStyles from '../../../site/canvas/CanvasRoot.module.css'
import type { TiptapBodyEditorHandle } from '@content/TiptapBodyEditor'
import { ContentModeToggle, type ContentMode } from '../ContentModeToggle/ContentModeToggle'
import styles from '../../ContentPage.module.css'
import { EmptyState } from '@ui/components/EmptyState'
import { ArticleSolidIcon } from 'pixel-art-icons/icons/article-solid'

const TiptapBodyEditor = lazy(() =>
  import('@content/TiptapBodyEditor').then((m) => ({ default: m.TiptapBodyEditor })),
)

const LiveCanvas = lazy(() =>
  import('../LiveCanvas/LiveCanvas').then((m) => ({ default: m.LiveCanvas })),
)

interface ContentDocumentCanvasProps {
  selectedEntry: DataRow | null
  selectedCollection: DataTable | null
  loading: boolean
  title: string
  body: string
  notchActions: CanvasNotchAction[]
  canEditEntry: boolean
  canCreateEntry: boolean
  /**
   * Bumped by the parent whenever the title field should be re-focused
   * (e.g. just after a new entry was created). Using a counter rather than
   * a boolean lets us re-trigger focus for back-to-back creations.
   */
  focusTitleSignal: number
  /**
   * Bumped by the parent whenever the body editor should focus the start
   * of its document (e.g. when Enter was pressed in the title field).
   */
  focusBodySignal: number
  /**
   * Display mode for the canvas — `'write'` is the bare Tiptap surface,
   * `'live'` renders the entry inside its real template via an iframe
   * with inline editing wired up to the same body markdown.
   */
  contentMode: ContentMode
  onContentModeChange: (mode: ContentMode) => void
  onTitleChange: (value: string) => void
  onTitleEnter: () => void
  onBodyChange: (markdown: string) => void
  onPickMedia: () => void
  onInsertDataToken: () => void
  onCreateEntry: () => void
}

export const ContentDocumentCanvas = forwardRef<TiptapBodyEditorHandle, ContentDocumentCanvasProps>(
  function ContentDocumentCanvas(props, ref) {
    const {
      selectedEntry,
      selectedCollection,
      loading,
      title,
      body,
      notchActions,
      canEditEntry,
      canCreateEntry,
      focusTitleSignal,
      focusBodySignal,
      contentMode,
      onContentModeChange,
      onTitleChange,
      onTitleEnter,
      onBodyChange,
      onPickMedia,
      onInsertDataToken,
      onCreateEntry,
    } = props

    const titleFieldRef = useRef<HTMLTextAreaElement | null>(null)
    const bodyEnabled = selectedCollection ? dataTableHasField(selectedCollection, POST_TYPE_FIELD_BODY) : false
    const editorEnabled = Boolean(selectedEntry && canEditEntry)
    const showInsertNotch = bodyEnabled && (editorEnabled || (!selectedEntry && canCreateEntry))
    const singularLabel = selectedCollection?.singularLabel.toLowerCase() ?? 'entry'

    useLayoutEffect(() => {
      resizeTitleField(titleFieldRef.current)
    }, [title])

    // Focus the title field whenever the parent bumps the signal. We skip
    // the initial mount (signal === 0) so navigating to an existing entry
    // doesn't hijack focus.
    useLayoutEffect(() => {
      if (focusTitleSignal === 0) return
      const node = titleFieldRef.current
      if (!node || node.disabled) return
      node.focus()
      const length = node.value.length
      node.setSelectionRange(length, length)
    }, [focusTitleSignal])

    function handleTitleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
      if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
      // Title is a single-line field: Enter should jump to the body editor
      // rather than inserting a newline.
      event.preventDefault()
      onTitleEnter()
    }

    return (
      <div
        role="region"
        aria-label="Content canvas"
        data-testid="content-canvas-root"
        className={cn(canvasStyles.canvas, styles.contentCanvas)}
      >
        {selectedEntry && bodyEnabled && (
          <ContentModeToggle mode={contentMode} onChange={onContentModeChange} />
        )}

        {/* The insertion notch is meaningful only in Write mode — Live
            mode has its own block affordances inside the iframe. */}
        {showInsertNotch && contentMode === 'write' && (
          <CanvasNotch
            actions={notchActions}
            addControl={null}
            showHistoryControls={false}
          />
        )}

        <div className={styles.documentScroll}>
          {loading ? (
            <ContentCanvasLoading />
          ) : selectedEntry ? (
            contentMode === 'live' && bodyEnabled ? (
              <Suspense fallback={<ContentCanvasLoading />}>
                <LiveCanvas
                  entry={selectedEntry}
                  collection={selectedCollection}
                  title={title}
                  body={body}
                  readOnly={!editorEnabled}
                  editorRef={ref as Ref<TiptapBodyEditorHandle>}
                  onBodyChange={onBodyChange}
                  onPickMedia={onPickMedia}
                  onInsertDataToken={onInsertDataToken}
                />
              </Suspense>
            ) : (
              <article className={styles.document}>
                <Textarea
                  ref={titleFieldRef}
                  value={title}
                  rows={1}
                  resize="none"
                  placeholder="Untitled"
                  aria-label="Title"
                  onChange={(event) => {
                    resizeTitleField(event.currentTarget)
                    onTitleChange(event.target.value)
                  }}
                  onKeyDown={handleTitleKeyDown}
                  disabled={!editorEnabled}
                  className={styles.titleInput}
                  fieldSize="md"
                  emphasis="strong"
                />
                {bodyEnabled && (
                  <Suspense fallback={<SkeletonBlock minHeight={180} />}>
                    <TiptapBodyEditor
                      markdown={body}
                      readOnly={!editorEnabled}
                      focusSignal={focusBodySignal}
                      editorRef={ref as Ref<TiptapBodyEditorHandle>}
                      onChange={onBodyChange}
                      onPickMedia={onPickMedia}
                      onInsertDataToken={onInsertDataToken}
                    />
                  </Suspense>
                )}
              </article>
            )
          ) : (
            <EmptyState
              variant="centered"
              icon={<ArticleSolidIcon size={28} />}
              title={`Create the first ${singularLabel}`}
              description="Select a collection and create an entry to start writing."
              action={
                <Button variant="primary" size="md" onClick={onCreateEntry} disabled={!selectedCollection || !canCreateEntry}>
                  <FilePlusSolidIcon size={15} aria-hidden="true" />
                  <span>New {selectedCollection?.singularLabel ?? 'Entry'}</span>
                </Button>
              }
              className={styles.emptyState}
            />
          )}
        </div>
      </div>
    )
  },
)

function resizeTitleField(node: HTMLTextAreaElement | null) {
  if (!node) return
  node.style.height = 'auto'
  if (node.scrollHeight > 0) {
    node.style.height = `${node.scrollHeight}px`
  }
}

function ContentCanvasLoading() {
  // Universal three-bar skeleton — matches every other loading region
  // in the editor (dashboard widgets, plugin cards, dialogs, admin
  // page bodies). The bespoke title / line / block shapes this file
  // used to render have been retired in favour of `<SkeletonBlock>`
  // so the document canvas loads with the same visual language as
  // the rest of the app.
  return (
    <div
      className={styles.canvasLoading}
      data-testid="content-canvas-loading"
      aria-busy="true"
      aria-label="Loading content"
    >
      <SkeletonBlock minHeight={240} />
    </div>
  )
}
