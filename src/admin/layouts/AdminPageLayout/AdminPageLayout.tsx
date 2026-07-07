/**
 * AdminPageLayout — the lightweight admin shell for non-editor pages.
 *
 * One of the two top-level admin layouts in `src/admin/layouts/`:
 *   - AdminCanvasLayout — used by the Site editor. Carries the floating
 *     editor panels, the page canvas, and the SiteExplorer DnD context.
 *   - AdminWorkspaceCanvasLayout — used by Content / Data / Media. Keeps the
 *     canvas chrome without importing Site-only editor panels.
 *   - AdminPageLayout (this file) — used by Plugins, Users, Account, and
 *     plugin admin pages. Strips the canvas / sidebar / DnD chrome and
 *     renders a simple centered page body with a unified header (title,
 *     description, optional tabs and actions slots).
 *
 * Pick AdminWorkspaceCanvasLayout for non-site canvas workspaces. Pick this
 * layout when the page is a regular admin page (lists, forms, settings).
 *
 * Bundle isolation contract (see also vite.config.ts comments)
 * ───────────────────────────────────────────────────────────
 * This layout MUST NOT import from `@site/store`, `@site/hooks/usePersistence`,
 * or anything else that drags the full editor store (~165 KB) into the
 * eager admin graph. The site name + favicon come from the tiny
 * `useSiteSummary` hook (one cmsAdapter fetch). The settings modal open
 * flag lives in the `adminUi` store, which the editor's settings slice
 * mirrors via a registered bridge.
 *
 * Concretely: visiting `/admin/users` should download only `react-vendor`,
 * `validation-vendor`, the page-specific chunk, and the shared `layouts-*`
 * chunk — NOT `store-*` (editor) or any panel/canvas/modules code.
 */
import { lazy, Suspense, type ReactNode } from 'react'
import { Toolbar } from '@site/toolbar/Toolbar'
import { AdminSectionNavigation } from '@admin/shared/AdminSectionNavigation'
import { SkeletonCards } from '@ui/components/Skeleton'
import { useEditorAppearancePreferences } from '@site/preferences/editorPreferences'
import { useInstalledEditorPlugins } from '@admin/pages/plugins/hooks/useInstalledEditorPlugins'
import { usePluginEventBridge } from '@admin/pages/plugins/hooks/usePluginEventBridge'
import { useCurrentAdminUser } from '@admin/sessionContext'
import { useAdminUi } from '@admin/state/adminUi'
import { useSiteSummary } from '@admin/state/useSiteSummary'
import { canRunPluginBackgroundWork } from '@admin/access'
import type { AdminWorkspace } from '@admin/workspace'
import styles from './AdminPageLayout.module.css'

// SettingsModal lives in its own chunk via React.lazy(). The conditional
// render below keeps it out of the eager graph until the user opens it.
// The matching declarations in the canvas layouts share the same lazy
// boundary, so the resolved module is cached once per session regardless
// of which layout opened it first.
const SettingsModal = lazy(() =>
  import('@admin/modals/Settings/SettingsModal').then((m) => ({ default: m.SettingsModal })),
)

interface AdminPageLayoutProps {
  /** Active section — drives the toolbar's nav highlight. */
  workspace: AdminWorkspace
  /** Page title rendered in the H1 of the page header. */
  title: string
  /** Optional description shown under the title. */
  description?: string
  /**
   * Optional tab buttons. Rendered to the right of the title block, before
   * `actions`. Pass a row of `<Button>` components — the layout only handles
   * positioning; the page owns selected-state and click handling.
   */
  tabs?: ReactNode
  /**
   * Optional primary actions (e.g. "Upload Plugin", "Create User"). Rendered
   * to the right of the tabs.
   */
  actions?: ReactNode
  /**
   * Optional extra toolbar items rendered in the toolbar's right slot. The
   * Settings cog, "Open live page", and account menu are appended globally
   * by the Toolbar shell itself — pages must not pass their own SettingsButton
   * here.
   */
  toolbarRightSlot?: ReactNode
  /** Optional id for the H1 — useful for `aria-labelledby` on the body. */
  titleId?: string
  /**
   * True while the page's primary content is being fetched. Renders a
   * universal page-shaped skeleton in place of `children` (a heading
   * line + 2 text lines + a content block) and sets `aria-busy="true"`
   * on the `<main>` body. Same three-bar visual language the
   * `<Widget>`, `<PluginCard>`, and `<Dialog>` primitives use. One
   * prop, no per-page skeleton markup.
   */
  loading?: boolean
  /** Page body. */
  children?: ReactNode
}

export function AdminPageLayout({
  workspace,
  title,
  description,
  tabs,
  actions,
  toolbarRightSlot,
  titleId,
  loading = false,
  children,
}: AdminPageLayoutProps) {
  const currentUser = useCurrentAdminUser()
  const pluginBackgroundWorkEnabled = canRunPluginBackgroundWork(currentUser)

  // Lightweight admin-shell hydration:
  //   - useSiteSummary: fetches { name, faviconUrl } via cmsAdapter and
  //     publishes to adminUi. No editor store touched.
  //   - usePluginEventBridge: SSE subscription for plugin-state updates.
  //   - useInstalledEditorPlugins: re-activates editor-side plugin modules.
  // We deliberately do NOT call `usePersistence` or
  // `useEditorLayoutPersistence` here — those hydrate / persist editor-only
  // state and would pull the full editor store into this layout's graph.
  useSiteSummary()
  useInstalledEditorPlugins(pluginBackgroundWorkEnabled)
  usePluginEventBridge(pluginBackgroundWorkEnabled)

  const appearance = useEditorAppearancePreferences()
  const siteName = useAdminUi((s) => s.siteName)
  const faviconUrl = useAdminUi((s) => s.siteFaviconUrl)
  const settingsOpen = useAdminUi((s) => s.settingsOpen)

  return (
    <div
      className={styles.shell}
      data-editor-density={appearance.density}
      data-editor-theme={appearance.theme}
      data-editor-text-scale={appearance.textScale}
    >
      <Toolbar
        siteName={siteName}
        faviconUrl={faviconUrl}
        section={workspace}
        adminNavigationSlot={(
          <AdminSectionNavigation
            section={workspace}
            currentUser={currentUser}
          />
        )}
        rightSlot={toolbarRightSlot}
      />

      <main className={styles.body} aria-busy={loading || undefined}>
        <div className={styles.container}>
          <header className={styles.header}>
            <div className={styles.titleGroup}>
              <h1 id={titleId}>{title}</h1>
              {description && <p>{description}</p>}
            </div>
            {(tabs || actions) && (
              <div className={styles.headerEnd}>
                {tabs && (
                  <div className={styles.tabs}>{tabs}</div>
                )}
                {actions && (
                  <div className={styles.actions}>{actions}</div>
                )}
              </div>
            )}
          </header>
          {loading ? <SkeletonCards count={3} /> : children}
        </div>
      </main>

      {settingsOpen && (
        <Suspense fallback={null}>
          <SettingsModal />
        </Suspense>
      )}
    </div>
  )
}
