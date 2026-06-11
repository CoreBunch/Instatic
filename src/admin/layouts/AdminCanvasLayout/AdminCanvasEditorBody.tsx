import {
  DndContext,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { lazy, Suspense } from 'react'
import { CanvasRoot } from '@admin/pages/site/canvas'
import { CodeEditorPanel, CodeEditorSkeleton } from '@admin/pages/site/code-editor'
import { useActiveLivePath } from '@admin/pages/site/hooks/useActiveLivePath'
import { useAutoResolveDependencies } from '@admin/pages/site/hooks/useAutoResolveDependencies'
import { LayoutNameDialog } from '@admin/pages/site/dialogs/LayoutNameDialog'
import { PropertiesPanel } from '@admin/pages/site/panels/PropertiesPanel'
import { LeftSidebar } from '@admin/pages/site/sidebars/LeftSidebar'
import { RightSidebar } from '@admin/pages/site/sidebars/RightSidebar'
import { selectRightSidebarExpanded, useEditorStore } from '@admin/pages/site/store/store'
import { ConfirmDeleteProvider } from '@admin/shared/dialogs/ConfirmDeleteDialog'
import { Dialog } from '@ui/components/Dialog'
import { Button } from '@ui/components/Button'
import { cn } from '@ui/cn'
import styles from './AdminCanvasLayout.module.css'

// Register the editor-only runtime graph from the lazy body, not the route
// shell. The toolbar/chrome can paint without block definitions or loop
// sources; CanvasRoot and PropertiesPanel need them.
import '@modules/base'
import '@core/loops/sources'

const ImportHtmlModal = lazy(() =>
  import('@admin/modals/ImportHtml').then((m) => ({ default: m.ImportHtmlModal })),
)

interface AdminCanvasEditorBodyProps {
  canEditDraftSite: boolean
  canSaveSite: boolean
  loadError: string | null
}

export function AdminCanvasEditorBody({
  canEditDraftSite,
  canSaveSite,
  loadError,
}: AdminCanvasEditorBodyProps) {
  // Keep `siteRuntime.dependencyLock` in lockstep with `packageJson` while
  // the editor body is open.
  useAutoResolveDependencies()
  // Own the toolbar's "Open live page" target. Resolves templates to the
  // page / post they're previewed against (templates have no routable slug of
  // their own); lives here, in the lazy body, so the CMS fetch it needs for
  // postTypes templates stays out of the admin-shell bundle.
  useActiveLivePath()

  const propertiesPanelMode = useEditorStore((s) => s.propertiesPanelMode)
  const rightSidebarExpanded = useEditorStore(selectRightSidebarExpanded)
  const importHtmlModalOpen = useEditorStore((s) => s.importHtmlModalOpen)
  const hasRightSidebar = rightSidebarExpanded

  // Site Explorer organization hooks into this outer DndContext. DomPanel has
  // its own nested DndContext for DOM tree reordering, isolated by dnd-kit.
  const canvasDndSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
  )

  return (
    <>
      {/* ── Canvas + floating overlay panels ──────────────────────────────── */}
      {/*
        position: relative makes this the containing block for absolutely
        positioned panels (Guideline #356 / Task #358 / Architect #504).
        flex is kept so CanvasRoot's flex:1 fills the full width.
        DndContext wraps the full editor body so SiteExplorerPanel rows can be
        reordered across sections and folders.
        DomPanel has its own nested DndContext for tree-node reordering — that
        context is isolated; nested DndContexts are fully supported by dnd-kit.
      */}
      <DndContext sensors={canvasDndSensors} collisionDetection={pointerWithin}>
        {/* `ConfirmDeleteProvider` wraps the editor body so the canvas
            Delete-key handler, Layers panel context menu, and other
            descendant destructive actions can call `useConfirmDelete()`
            and gate on the `confirmBeforeDelete` editor preference.
            Plugin uninstall is intentionally *not* gated on that preference
            and uses its own dedicated `PluginRemoveDialog` instead. */}
        <ConfirmDeleteProvider>
          <div className={styles.editorBody}>
            <LeftSidebar workspace="site" editable={canEditDraftSite} />
            <div
              className={cn(styles.canvasStage, hasRightSidebar && styles.canvasStageRightSidebarOpen)}
              data-right-sidebar-expanded={hasRightSidebar ? 'true' : 'false'}
            >
              <div className={styles.canvasContent} key="site">
                {/* Canvas — fills the remaining space between sidebars */}
                {loadError ? (
                  <SiteEditorLoadError message={loadError} />
                ) : (
                  <CanvasRoot editable={canEditDraftSite} />
                )}
                {/* Properties can be unpinned into the floating draggable overlay. */}
                {canSaveSite && propertiesPanelMode === 'floating' && <PropertiesPanel variant="floating" />}
              </div>
            </div>
            {/* `mode` tells the RightSidebar which expansion model to use:
                - `'site'`:      Site editor — width follows the selection-
                  gated `sitePropertiesExpanded` selector.
                - `'hidden'`:    Site viewer with no `pages.draft.save`
                  capability. */}
            <RightSidebar
              key="site"
              mode={canSaveSite ? 'site' : 'hidden'}
            />
          </div>
        </ConfirmDeleteProvider>
      </DndContext>

      {/* Code editor/media preview: viewport overlay, not constrained by the
          canvas stage. The panel itself is small chrome; the heavy CodeMirror
          6 bundle (~600 kB) is lazy-loaded inside the panel only when the
          user opens a text file. */}
      <CodeEditorPanel />

      {/* Naming step for "Save as layout" / saved-layout rename. Renders null
          until a layoutNameDialogRequest is set on the ui slice. */}
      <LayoutNameDialog />

      {/* Import HTML modal — opens from Spotlight or right-click "Paste HTML here…".
          The modal implementation is rarely used and pulls in the importer,
          tree preview, and HTML editor, so keep it behind this open-state
          lazy boundary. */}
      {importHtmlModalOpen && (
        <Suspense fallback={<ImportHtmlModalLoading />}>
          <ImportHtmlModal />
        </Suspense>
      )}
    </>
  )
}

function ImportHtmlModalLoading() {
  const closeModal = useEditorStore((s) => s.closeImportHtmlModal)

  return (
    <Dialog
      open={true}
      onClose={closeModal}
      title="Import HTML"
      eyebrow="Instatic"
      size="lg"
      className={styles.importHtmlLoadingDialog}
      bodyClassName={styles.importHtmlLoadingBody}
      footer={
        <>
          <Button variant="secondary" type="button" onClick={closeModal}>
            Cancel
          </Button>
          <Button variant="primary" type="button" disabled>
            Insert
          </Button>
        </>
      }
    >
      <div className={styles.importHtmlLoadingColumns}>
        <section className={styles.importHtmlLoadingPreviewColumn} aria-label="Tree preview">
          <div className={styles.importHtmlLoadingColumnHeader}>
            <h3 className={styles.importHtmlLoadingColumnTitle}>Tree preview</h3>
          </div>
          <div className={styles.importHtmlPreviewSkeleton} aria-hidden="true">
            <span className={styles.importHtmlPreviewSkeletonSummary} />
            <span className={styles.importHtmlPreviewSkeletonRow} />
            <span className={styles.importHtmlPreviewSkeletonRowIndented} />
            <span className={styles.importHtmlPreviewSkeletonRowIndented} />
          </div>
        </section>

        <section className={styles.importHtmlLoadingEditorColumn} aria-label="HTML source">
          <div className={styles.importHtmlLoadingColumnHeader}>
            <h3 className={styles.importHtmlLoadingColumnTitle}>HTML</h3>
          </div>
          <div className={styles.importHtmlEditorSkeleton}>
            <CodeEditorSkeleton />
          </div>
        </section>
      </div>
    </Dialog>
  )
}

function SiteEditorLoadError({ message }: { message: string }) {
  return (
    <section className={styles.canvasBootstrapError} role="alert">
      <h1>Could not load CMS site</h1>
      <p>{message}</p>
    </section>
  )
}
