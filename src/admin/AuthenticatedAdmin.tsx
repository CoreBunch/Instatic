/**
 * AuthenticatedAdmin — the heavy admin shell.
 *
 * This file owns everything the login screen does NOT need:
 *   - SpotlightRoot (Cmd+K palette) + its keybinding listener
 *   - AdminSessionProvider (session context for authenticated children)
 *   - StepUpProvider (auth re-verification for sensitive actions)
 *   - The 9 workspace page components (DashboardPage, SitePage, …)
 *   - installPluginRuntime() (populates globalThis.__instatic for plugins)
 *
 * Splitting this out from `AdminEntry` keeps the cold-load JS execution
 * gap small for the unauthenticated login flow: the entry chunk no longer
 * has to module-evaluate all of the above on the login screen.
 *
 * The component is loaded by `AdminEntry` via React.lazy when (and only
 * when) the boot probe resolves to `phase === 'editor'`.
 *
 * Workspace pages — the navigation-feel optimization
 * --------------------------------------------------
 * Each workspace page is wrapped with `prewarmedLazy(...)`. The pattern
 * is "load the active page first, others in idle time after":
 *
 *   1. The page the user is on (e.g., DashboardPage when section ===
 *      'dashboard') loads first. React renders it; `prewarmedLazy`'s
 *      cold-path triggers `.preload()` and suspends to the nearest
 *      Suspense boundary until the import lands. The DASHBOARD chunk
 *      gets vite's CPU / the HTTP connection slot to itself — no 8
 *      sibling compilations competing for resources.
 *
 *   2. After the active page paints (i.e., the user actually sees the
 *      dashboard), an effect fires `requestIdleCallback` to schedule
 *      `.preload()` calls for the OTHER 8 workspace pages. They load
 *      in the background while the user is reading the dashboard.
 *
 *   3. When the user clicks any nav link, the target page's cached
 *      component renders synchronously via `prewarmedLazy`'s
 *      fast-path. No microtask, no Suspense fallback, no flash.
 *
 * Why this beats React.lazy + module-load auto-prewarm:
 *   - React.lazy returns a fresh `.then()` chain on every render → one-
 *     tick Suspense flash on every nav even with cached chunks.
 *   - Auto-prewarming at construction time (the previous version of
 *     this file) fires all 9 imports simultaneously, which makes the
 *     active page COMPETE for vite-CPU / HTTP connections with 8
 *     sibling chunks. The user perceives the active page as slower.
 *
 * Cost: same as before — every authenticated user eventually downloads
 * + compiles all workspace page chunks. The difference is the SCHEDULE:
 * active first, others in idle time. Total wire bytes are unchanged.
 */
import { lazy, Suspense, useEffect } from 'react'
import type { CmsCurrentUser } from '@core/persistence'
import { AppLoadingScreen } from './AppLoadingScreen'
import type { AdminWorkspace } from './workspace'
import { AdminSessionProvider } from './session'
import { StepUpProvider } from './shared/StepUp'
import { canAccessWorkspace, firstAccessibleWorkspace, workspacePath } from './access'
import { Navigate, useInRouterContext } from './lib/routing'
import { SpotlightRoot } from './spotlight'
import { prewarmedLazy } from './lib/prewarmedLazy'
import { useAdminUi } from './state/adminUi'
import styles from './AdminEntry.module.css'

// The 9 workspace pages — pre-warmed AND synchronously-renderable once
// loaded. See file header for the rationale.
const DashboardPage = prewarmedLazy(
  () => import('./pages/dashboard/DashboardPage').then((m) => ({ default: m.DashboardPage })),
  { displayName: 'DashboardPage' },
)
const SitePage = prewarmedLazy(
  () => import('./pages/site/SitePage').then((m) => ({ default: m.SitePage })),
  { displayName: 'SitePage' },
)
const ContentPage = prewarmedLazy(
  () => import('./pages/content/ContentPage').then((m) => ({ default: m.ContentPage })),
  { displayName: 'ContentPage' },
)
const MediaPage = prewarmedLazy(
  () => import('./pages/media/MediaPage').then((m) => ({ default: m.MediaPage })),
  { displayName: 'MediaPage' },
)
const PluginsPage = prewarmedLazy(
  () => import('./pages/plugins/PluginsPage').then((m) => ({ default: m.PluginsPage })),
  { displayName: 'PluginsPage' },
)
const PluginPage = prewarmedLazy(
  () => import('./pages/plugins/PluginPage').then((m) => ({ default: m.PluginPage })),
  { displayName: 'PluginPage' },
)
const UsersPage = prewarmedLazy(
  () => import('./pages/users/UsersPage').then((m) => ({ default: m.UsersPage })),
  { displayName: 'UsersPage' },
)
const AiPage = prewarmedLazy(
  () => import('./pages/ai/AiPage').then((m) => ({ default: m.AiPage })),
  { displayName: 'AiPage' },
)
const SeoPage = prewarmedLazy(
  () => import('./pages/seo/SeoPage').then((m) => ({ default: m.SeoPage })),
  { displayName: 'SeoPage' },
)
const AccountPage = prewarmedLazy(
  () => import('./pages/account/AccountPage').then((m) => ({ default: m.AccountPage })),
  { displayName: 'AccountPage' },
)
const DataPage = prewarmedLazy(
  () => import('./pages/data/DataPage').then((m) => ({ default: m.DataPage })),
  { displayName: 'DataPage' },
)

const SiteImportModal = lazy(() =>
  import('./modals/SiteImport').then((m) => ({ default: m.SiteImportModal })),
)

const SiteExportModal = lazy(() =>
  import('./modals/SiteExport').then((m) => ({ default: m.SiteExportModal })),
)

// Plugin runtime (globalThis.__instatic) is now installed LAZILY by
// `ensurePluginRuntime()` in `pluginRuntimeBootstrap.ts`. The two callers
// that need it (useInstalledEditorPlugins, PluginPageRenderer) await it
// before triggering their plugin dynamic-imports. Eagerly installing
// here dragged the editor store (109 KB) + plugin host UI + plugin SDK
// into the dashboard's critical path — every cold-load of /admin/dashboard
// blocked on that download + parse even though the dashboard doesn't use
// any of it.

// Module-evaluation-time preload of the active page's `prewarmedLazy`.
//
// `main.tsx` already `await`s `import('./pages/<section>/<Section>Page')`
// so the chunk is in the browser's module cache by the time
// AuthenticatedAdmin's module loads. But the `prewarmedLazy.cached`
// field is set inside the wrapper's `.then(...)` callback — the
// `import(...)` promise itself resolves synchronously, but the `.then`
// creates a microtask gap. If React's first render of the page lands
// BEFORE that microtask completes, prewarmedLazy throws to Suspense,
// the fallback renders, the microtask resolves, then Suspense retries
// — and that retry runs in CONCURRENT mode (Suspense's retry never
// goes through `flushSync`). The concurrent-mode commit defers behind
// browser layout / paint / chunk-parse work by ~280 ms on cold load.
//
// Firing `.preload()` here, at module evaluation, queues the `.then()`
// microtask BEFORE React renders. The microtask completes in the same
// task as the module load, so by the time React calls the prewarmedLazy
// wrapper, `cached` is set and the render goes through the synchronous
// fast-path — no Suspense round-trip, no concurrent re-render.
//
// We pick the wrapper by URL pathname; the others stay dormant until
// either the user navigates to them (`prewarmedLazy`'s cold path) or
// the `requestIdleCallback` background-preload effect fires below.
if (typeof window !== 'undefined') {
  const pathname = window.location.pathname
  const activePage =
    pathname.startsWith('/admin/site') ? SitePage :
    pathname.startsWith('/admin/content') ? ContentPage :
    pathname.startsWith('/admin/data') ? DataPage :
    pathname.startsWith('/admin/media') ? MediaPage :
    pathname.startsWith('/admin/plugins/') ? PluginPage :
    pathname.startsWith('/admin/plugins') ? PluginsPage :
    pathname.startsWith('/admin/users') ? UsersPage :
    pathname.startsWith('/admin/ai') ? AiPage :
    pathname.startsWith('/admin/tools/seo') ? SeoPage :
    pathname.startsWith('/admin/account') ? AccountPage :
    DashboardPage
  void activePage.preload().catch(() => {
    // Cold-render retry will re-fire preload via prewarmedLazy's throw.
  })
}

interface AuthenticatedAdminProps {
  section: AdminWorkspace
  currentUser: CmsCurrentUser
}

// Every prewarmedLazy-wrapped workspace page, in one list so the
// background-preload scheduler can iterate without naming each one.
// Order matches the rough frequency of use (Site / Content / Data are
// the canonical creator workflows; Plugins / Users / Account are
// admin-only one-offs) — `requestIdleCallback` doesn't promise a
// specific order, but if the browser starts firing requests round-
// robin, this puts the most-likely-next pages first.
const ALL_WORKSPACE_PAGES = [
  SitePage,
  ContentPage,
  DataPage,
  DashboardPage,
  MediaPage,
  PluginsPage,
  UsersPage,
  AiPage,
  SeoPage,
  AccountPage,
  PluginPage,
]

function pageForSection(section: AdminWorkspace) {
  return (
    section === 'site' ? SitePage :
    section === 'content' ? ContentPage :
    section === 'data' ? DataPage :
    section === 'media' ? MediaPage :
    section === 'plugins' ? PluginsPage :
    section === 'users' ? UsersPage :
    section === 'ai' ? AiPage :
    section === 'seo' ? SeoPage :
    section === 'pluginPage' ? PluginPage :
    section === 'account' ? AccountPage :
    DashboardPage
  )
}

export default function AuthenticatedAdmin({ section, currentUser }: AuthenticatedAdminProps) {
  const inRouter = useInRouterContext()
  const fallbackWorkspace = firstAccessibleWorkspace(currentUser)
  const siteImportOpen = useAdminUi((s) => s.siteImportOpen)
  const siteExportOpen = useAdminUi((s) => s.siteExport !== null)

  // Schedule background preloads for non-active workspace pages AFTER
  // the active page has rendered + painted. `useEffect` fires after
  // the browser's first paint of the active page, so the user sees the
  // dashboard (or whatever section they landed on) before we kick off
  // network/CPU work for sibling pages.
  //
  // `requestIdleCallback` is the right primitive here — it fires when
  // the browser has truly idle main-thread time. In dev mode that's
  // after vite has finished compiling everything the active page
  // needs; in prod it's almost immediately after paint. Fallback to
  // setTimeout for browsers that don't support it (Safari < 17).
  useEffect(() => {
    type IdleCb = (cb: () => void, options?: { timeout?: number }) => number
    type CancelIdleCb = (id: number) => void
    const w = window as unknown as {
      requestIdleCallback?: IdleCb
      cancelIdleCallback?: CancelIdleCb
    }
    const activePage = pageForSection(section)
    const fire = () => {
      for (const page of ALL_WORKSPACE_PAGES) {
        if (page === activePage) continue
        // `.preload()` is idempotent — the active page's preload is
        // already in flight (or resolved). The sibling pages actually
        // fire their imports here.
        void page.preload().catch(() => {
          // Best-effort. A single failed background preload is not
          // fatal — the page will retry via its render-path preload
          // when the user actually navigates to it.
        })
      }
    }
    const scheduleIdlePreload = () => {
      if (typeof w.requestIdleCallback === 'function') {
        // The `timeout: 2000` cap means even on a busy main thread we
        // start within 2s of paint. That's the latest a typical user
        // takes to click their first nav link, so we're racing them
        // exactly the right amount.
        const idleId = w.requestIdleCallback(fire, { timeout: 2000 })
        return () => w.cancelIdleCallback?.(idleId)
      }

      const timeoutId = window.setTimeout(fire, 300)
      return () => window.clearTimeout(timeoutId)
    }

    if (section === 'site') {
      // `/admin/site` has a second, active-route post-paint import:
      // AdminCanvasEditorBody. Let that editor body claim the first idle
      // slot before warming sibling workspace pages; otherwise Content/Data
      // preloads start first and delay the canvas/dnd work the user actually
      // asked for by opening Site.
      let cancelIdlePreload: (() => void) | null = null
      const timeoutId = window.setTimeout(() => {
        cancelIdlePreload = scheduleIdlePreload()
      }, 800)
      return () => {
        window.clearTimeout(timeoutId)
        cancelIdlePreload?.()
      }
    }

    return scheduleIdlePreload()
  }, [section])

  if (!canAccessWorkspace(currentUser, section)) {
    if (inRouter && fallbackWorkspace) {
      return <Navigate to={workspacePath(fallbackWorkspace)} replace />
    }
    return (
      <main className={styles.page}>
        <section className={styles.panel} role="alert">
          <h1 className={styles.title}>Access unavailable</h1>
          <p className={styles.error}>Your role does not include access to this admin section.</p>
        </section>
      </main>
    )
  }

  return (
    <AdminSessionProvider user={currentUser}>
      {/* StepUpProvider wraps SpotlightRoot so spotlight commands can
          consume `useStepUp()` — required by step-up-gated actions invoked
          from the palette (e.g. `editor.publish`). Both providers stay
          inside AdminSessionProvider (the palette's CommandContext reads
          the authenticated user) and above the workspace switch so the
          palette and the step-up dialog are available across every
          workspace. */}
      <StepUpProvider>
        <SpotlightRoot>
          {/* Suspense catches:
                - First-visit cold-path of a prewarmedLazy page (it throws
                  the pending import promise the first time). On subsequent
                  visits the prewarmedLazy renders synchronously and this
                  boundary never fires.
                - Downstream `React.lazy()` inside pages (e.g. content body
                  editor / LiveCanvas / CodeMirrorEditor). Those remain
                  legitimately lazy because the editor surfaces are large and
                  shouldn't ship until needed. */}
          <Suspense fallback={<AppLoadingScreen />}>
            {section === 'dashboard' ? <DashboardPage /> :
              section === 'site' ? <SitePage /> :
              section === 'content' ? <ContentPage /> :
              section === 'data' ? <DataPage /> :
              section === 'media' ? <MediaPage /> :
              section === 'plugins' ? <PluginsPage /> :
              section === 'users' ? <UsersPage /> :
              section === 'ai' ? <AiPage /> :
              section === 'seo' ? <SeoPage /> :
              section === 'pluginPage' ? <PluginPage /> :
              section === 'account' ? <AccountPage /> :
              <DashboardPage />}
          </Suspense>
          {siteImportOpen && (
            <Suspense fallback={null}>
              <SiteImportModal />
            </Suspense>
          )}
          {siteExportOpen && (
            <Suspense fallback={null}>
              <SiteExportModal />
            </Suspense>
          )}
        </SpotlightRoot>
      </StepUpProvider>
    </AdminSessionProvider>
  )
}
