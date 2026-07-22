/**
 * AdminCanvasLayout — the Site editor admin shell.
 *
 * One of the admin layout families in `src/admin/layouts/`:
 *   - AdminCanvasLayout (this file) — used by the Site editor. Paints the
 *     real toolbar/chrome first, then lazy-loads the editor body containing
 *     floating panels, page canvas, and Site Explorer's shared DnD context.
 *   - AdminPageLayout — used by Plugins, Users, Account, and plugin admin
 *     pages. Strips the canvas / sidebar / DnD chrome and renders a
 *     simple centered page body with a unified header.
 *   - AdminWorkspaceCanvasLayout — used by Content, Data, and Media. Keeps
 *     the canvas chrome without importing Site-editor-only modules.
 *
 * Pick AdminCanvasLayout for the visual Site editor. Content, Data, and Media
 * use AdminWorkspaceCanvasLayout so they do not download Site-editor-only
 * modules on first paint.
 *
 * Editor Overlay Layout (Guideline #410 — motion-editor style):
 *   ┌─────────────────────────────── Toolbar ──────────────────────────────────┐  z-60
 *   │ [SiteName] [Undo/Redo] [+ Add] ─────── [Zoom] [Save] [Publish] [⚙] [✦] │
 *   ├──────────────────────────── Canvas (full-bleed) ─────────────────────────┤
 *   │  [DOM Tree Panel ▓]     canvas          [Properties Panel ▓]            │
 *   │  position: absolute overlays (z-50)     [AI Panel ▓] (bottom-right)     │
 *   └──────────────────────────────────────────────────────────────────────────┘
 *
 * Five independent self-contained floating panels (Guideline #410):
 * - DomPanel (Layers) — top-left
 * - PropertiesPanel — top-right
 * - AgentPanel (AI) — bottom-right, independent visibility
 * - Site explorer panel — site concepts: pages, components, styles, scripts
 * - CodeEditorPanel (Task #432) — center-stage, code editing
 *
 * J12: usePersistence handles CMS draft load on mount, preference-gated
 * 30s auto-save, toolbar Save, and Cmd+S immediate save.
 *
 * Agent Panel: Phase D AI assistant — self-contained floating panel (Guideline #410).
 * Authenticates via ambient Claude Code credentials through the local Bun server.
 * No env vars, no API keys, no endpoint configuration required (Constraint #385).
 */
import { Toolbar } from '@admin/pages/site/toolbar/Toolbar'
import { ZoomControls } from '@admin/pages/site/toolbar/ZoomControls'
import { PublishButton } from '@admin/pages/site/toolbar/PublishButton'
import { useEditorAppearancePreferences } from '@admin/pages/site/preferences/editorPreferences'
import { usePersistence } from '@admin/pages/site/hooks/usePersistence'
import { useSiteEditorUrlSync } from '@admin/pages/site/hooks/useSiteEditorUrlSync'
import { useEditorLayoutPersistence } from '@admin/pages/site/hooks/useEditorLayoutPersistence'
import { useEditorStore } from '@admin/pages/site/store/store'
import { cmsAdapter } from '@core/persistence/cms'
import { useAdminUi } from '@admin/state/adminUi'
import { useInstalledEditorPlugins } from '@admin/pages/plugins/hooks/useInstalledEditorPlugins'
import { usePluginEventBridge } from '@admin/pages/plugins/hooks/usePluginEventBridge'
import { AdminSectionNavigation } from '@admin/shared/AdminSectionNavigation'
import {
  CanvasFrameSkeletonFrame,
  DEFAULT_CANVAS_FRAME_SKELETON_BREAKPOINTS,
} from '@admin/shared/CanvasFrameSkeleton'
import { LazyChunkBoundary } from '@admin/lib/LazyChunkBoundary'
import { prewarmedLazy } from '@admin/lib/prewarmedLazy'
import styles from './AdminCanvasLayout.module.css'
import { lazy, Suspense, useEffect, useState } from 'react'
import { useCurrentAdminUser } from '@admin/sessionContext'
import {
  canEditContent as accessCanEditContent,
  canEditStructure as accessCanEditStructure,
  canEditStyle as accessCanEditStyle,
  canSaveDraftSite,
  canRunPluginBackgroundWork,
  canUseAiChat,
  hasCapability,
} from '@admin/access'
import { EditorPermissionsProvider } from '@site/EditorPermissionsProvider'
import type { EditorPermissions } from '@site/editorPermissionsContext'

interface AdminCanvasEditorBodyProps {
  canEditDraftSite: boolean
  canSaveSite: boolean
  canUseAiChat: boolean
  loadError: string | null
}

const AdminCanvasEditorBody = prewarmedLazy<AdminCanvasEditorBodyProps>(
  () =>
    import('./AdminCanvasEditorBody').then((m) => ({ default: m.AdminCanvasEditorBody })),
  { displayName: 'AdminCanvasEditorBody' },
)

// SettingsModal is heavy (~37 KB raw) and closed 99% of the time. lazy()
// pushes it into its own chunk and the conditional render below avoids
// kicking off the dynamic import until the user actually opens settings.
// Once opened, React.lazy() caches the resolved module — subsequent
// open/close cycles are instant.
const SettingsModal = lazy(() =>
  import('@admin/modals/Settings/SettingsModal').then((m) => ({ default: m.SettingsModal })),
)

// Editor-only toolbar surface: preview iframe. It self-gates on store state,
// but we ALSO conditionally render it at the call site (below) so its chunk
// isn't fetched on first paint. The overlay is an infrequent, modal surface
// whose server-built document should load only when the user asks for it.
const PreviewOverlay = lazy(() =>
  import('@admin/pages/site/preview/PreviewOverlay').then((m) => ({
    default: m.PreviewOverlay,
  })),
)

/**
 * AdminCanvasLayout is the Site editor shell. Other canvas-style workspaces
 * render through `AdminWorkspaceCanvasLayout`, and regular admin pages render
 * through `AdminPageLayout`.
 */
export function AdminCanvasLayout() {
  const site = useEditorStore((s) => s.site)
  // Toolbar branding — pulled from the editor store here (we already have
  // it loaded) and forwarded to the prop-driven Toolbar below. Keeps the
  // Toolbar component itself free of editor-store imports.
  const siteName = useEditorStore((s) => s.site?.name ?? null)
  const faviconUrl = useEditorStore((s) => s.site?.settings.faviconUrl ?? null)
  // Editor-only toolbar surface — gate its lazy chunk on store state.
  const previewOpen = useEditorStore((s) => s.previewOpen)
  // Settings modal mount gate. adminUi is the canonical source — the
  // editor's `settingsSlice.openSettings` mirrors into it, and the admin
  // shell reads from it too.
  const settingsOpen = useAdminUi((s) => s.settingsOpen)
  const publishSiteSummary = useAdminUi((s) => s.setSiteSummary)
  const currentUser = useCurrentAdminUser()
  const pluginBackgroundWorkEnabled = canRunPluginBackgroundWork(currentUser)

  // Keep the adminUi site summary in sync with whatever the editor store
  // currently holds. AdminPageLayout reads siteName / faviconUrl from
  // adminUi (not the editor store), so editor pages need to publish there
  // too. This effect fires whenever the underlying values change, and is
  // cheap because adminUi.setSiteSummary is a stable setter.
  useEffect(() => {
    if (siteName === null) return
    publishSiteSummary({ name: siteName, faviconUrl })
  }, [siteName, faviconUrl, publishSiteSummary])
  // The toolbar's "Open live page" target (adminUi.activeLivePath) is owned by
  // `useActiveLivePath` in the lazy editor body — it resolves templates to the
  // page / post they're previewed against instead of their non-routable slug.
  // Three-way edit permissions — see `src/admin/access.ts`. A user with all
  // three holds full editor rights; a user with only `canEditContent` is the
  // "Client / copy editor" persona: read everything, change copy on existing
  // nodes, no DnD, no style edits, no structural changes.
  const canEditStructureFlag = accessCanEditStructure(currentUser)
  const canEditContentFlag = accessCanEditContent(currentUser)
  const canEditStyleFlag = accessCanEditStyle(currentUser)
  const canSaveSite = canSaveDraftSite(currentUser)
  const canUseAgent = canUseAiChat(currentUser)
  // Legacy "anything-editable" flag — true when the caller can drag/drop and
  // structurally modify the canvas. Most existing call sites are structural
  // by nature (DnD, context menu, rename, delete keyboard shortcut, plugin
  // overlays). Content-only callers still get the canvas in read-mostly mode
  // with content controls live.
  const canEditDraftSite = canEditStructureFlag
  const canPublishPages = !currentUser || hasCapability(currentUser, 'pages.publish')

  const permissions: EditorPermissions = {
    canEditStructure: canEditStructureFlag,
    canEditContent: canEditContentFlag,
    canEditStyle: canEditStyleFlag,
  }
  // J12 — wire persistence: load, auto-save, toolbar Save, Cmd+S.
  const persistence = usePersistence('default', cmsAdapter, {
    markNewSiteUnsaved: true,
    enabled: true,
  })
  // Keep the open page in lockstep with the URL: consume `?page=<slug>` on
  // load, and mirror the active page's slug back into the address bar so it's
  // directly linkable.
  useSiteEditorUrlSync({
    enabled: true,
    loaded: persistence.saveStatus.state !== 'loading',
  })
  useEditorLayoutPersistence()
  useInstalledEditorPlugins(pluginBackgroundWorkEnabled)
  // Mount the SSE bridge ONCE per admin tab — gives toasts on plugin
  // crashes from any route, drives the red dot on the Plugins nav link,
  // and keeps the open Plugins page list refreshed.
  usePluginEventBridge(pluginBackgroundWorkEnabled)

  // Appearance preferences — data attributes on the editor root drive CSS
  // variables consumed by tree rows, toolbar buttons, text scale, and the
  // admin theme. Reading the preferences here keeps the attributes in sync
  // with Settings without per-component subscriptions.
  //
  // Read BEFORE the `!site` early return so the hook order stays stable across
  // the hydration gate (React rules-of-hooks: hooks must run in the same order
  // on every render).
  const appearance = useEditorAppearancePreferences()

  const loadError = !site && persistence.saveStatus.state === 'error'
    ? persistence.saveStatus.message ?? 'Reload the admin page and try again.'
    : null

  const loadEditorBody = usePostPaintEditorBodyGate()
  async function saveBeforeWorkspaceNavigation(): Promise<void> {
    if (!useEditorStore.getState().hasUnsavedChanges) return
    await persistence.saveSite()
  }

  return (
    <EditorPermissionsProvider value={permissions}>
      <div
        className={styles.shell}
        data-editor-density={appearance.density}
        data-editor-theme={appearance.theme}
        data-editor-text-scale={appearance.textScale}
      >
        {/* ── Top toolbar (z-60, Guideline #374) ───────────────────────────── */}
        {/* Toolbar is now a prop-driven shell — this layout supplies the
            site brand, the preview overlay lazy mount, and
            the editor-specific right slot (zoom / publish / settings). The
            lazy mount gates on `previewOpen` so the chunk loads only when the
            user actually opens preview. */}
        <Toolbar
          siteName={siteName}
          faviconUrl={faviconUrl}
          section="site"
          adminNavigationSlot={(
            <AdminSectionNavigation
              section="site"
              currentUser={currentUser}
              onWorkspaceNavigateStart={canSaveSite ? saveBeforeWorkspaceNavigation : undefined}
            />
          )}
          overlay={previewOpen && (
            <Suspense fallback={null}>
              <PreviewOverlay />
            </Suspense>
          )}
          rightSlot={(
            <>
              <ZoomControls />
              <PublishButton
                enabled={canPublishPages}
                onSave={canSaveSite ? persistence.saveSite : undefined}
                saveStatus={persistence.saveStatus}
              />
            </>
          )}
        />

        {loadEditorBody ? (
          <LazyChunkBoundary
            location="site-editor-body"
            fallback={<AdminCanvasEditorBodyLoading />}
            resetKeys={[site?.id ?? null]}
            onReset={AdminCanvasEditorBody.reset}
          >
            <AdminCanvasEditorBody
              canEditDraftSite={canEditDraftSite}
              canSaveSite={canSaveSite}
              canUseAiChat={canUseAgent}
              loadError={loadError}
            />
          </LazyChunkBoundary>
        ) : (
          <AdminCanvasEditorBodyLoading />
        )}

        {/* Settings Modal (portal-rendered, listens to adminUi.settingsOpen).
            Lazy + conditional render — the 1300-line modal + its six section
            subtree stays out of the eager graph until the user opens settings. */}
        {settingsOpen && (
          <Suspense fallback={null}>
            <SettingsModal />
          </Suspense>
        )}

      </div>
    </EditorPermissionsProvider>
  )
}

function usePostPaintEditorBodyGate(): boolean {
  const delayBodyUntilPaint =
    typeof import.meta.env !== 'undefined' && import.meta.env.PROD === true
  const [loadEditorBody, setLoadEditorBody] = useState(!delayBodyUntilPaint)

  useEffect(() => {
    if (!delayBodyUntilPaint) return
    return scheduleAfterFirstPaint(() => setLoadEditorBody(true))
  }, [delayBodyUntilPaint])

  return loadEditorBody
}

function scheduleAfterFirstPaint(callback: () => void): () => void {
  if (typeof window === 'undefined') return () => {}

  if (typeof window.requestAnimationFrame !== 'function') {
    const timeoutId = window.setTimeout(callback, 0)
    return () => window.clearTimeout(timeoutId)
  }

  let secondFrameId: number | null = null
  const firstFrameId = window.requestAnimationFrame(() => {
    secondFrameId = window.requestAnimationFrame(callback)
  })

  return () => {
    window.cancelAnimationFrame(firstFrameId)
    if (secondFrameId !== null) window.cancelAnimationFrame(secondFrameId)
  }
}

function AdminCanvasEditorBodyLoading() {
  return (
    <div className={styles.editorBody} aria-busy="true">
      <div className={styles.canvasStage} data-right-sidebar-expanded="false">
        <div className={styles.canvasContent}>
          <section
            className={styles.canvasBootstrapStatus}
            role="status"
            aria-label="Loading editor"
          >
            <div className={styles.canvasBootstrapLayer} aria-hidden="true">
              {DEFAULT_CANVAS_FRAME_SKELETON_BREAKPOINTS.map((breakpoint) => (
                <CanvasFrameSkeletonFrame
                  key={breakpoint.id}
                  breakpoint={breakpoint}
                />
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
