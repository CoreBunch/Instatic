import { StrictMode } from 'react'
import { createRoot, type ErrorInfo } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { Router } from './lib/routing'
import { AdminRoutes } from './router'
import { AdminContextMenuGuard } from './shared/AdminContextMenuGuard'
import { AdminZoomGuard } from './shared/AdminZoomGuard'
import { ErrorBoundary, flattenErrorChain, logErrorChain } from '@ui/components/ErrorBoundary'
import { ToastProvider, pushToast } from '@ui/components/Toast'
import '../styles/globals.css'
import { installBranchRequestHeaders } from './state/activeBranch'

// `installPluginRuntime()` used to be called here, eagerly. That dragged
// the whole plugin-host-hooks module (which imports `useEditorStore` from
// `@site/store/store`) into the first-paint bundle — roughly 116 KB of
// editor-store code that the login screen never uses. The plugin runtime
// is now installed from inside `AdminEntry`'s lazy chunk, which still runs
// well before any plugin chunk actually loads (plugin chunks come in via
// AdminEntry's downstream lazy routes). Net effect: removed `store-*.js`
// and most state-vendor traffic from the eager paint.
//
// Base module registration is also deferred to AdminEntry (the lazy admin
// chunk) so the publisher / page-tree / sanitize stack stays out of the
// eager entry bundle. See src/modules/base/index.ts.

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Root element #root not found')

// React 19 root-level error callbacks — single telemetry funnel that fires
// even for errors caught by an <ErrorBoundary>. Logs follow the project's
// `[<module>]` prefix convention and walk error.cause chains so domain-typed
// errors render their full provenance.
//
// `onCaughtError` fires AFTER a boundary catches; we don't toast for those
// because the boundary itself already toasted with location context.
// `onUncaughtError` fires when no boundary caught — these are the dangerous
// ones; we toast loudly.
// `onRecoverableError` fires when React recovered (e.g. failed hydration that
// fell back to client render). Logged but not toasted.
function handleRootError(
  prefix: string,
  error: unknown,
  info: ErrorInfo,
  toastTitle: string | null,
): void {
  const chain = flattenErrorChain(error)
  logErrorChain(prefix, chain, info.componentStack ?? null)
  if (toastTitle) {
    const head = chain[0]
    pushToast({
      kind: 'error',
      title: toastTitle,
      body: `${head.name}: ${head.message}`,
      location: prefix,
    })
  }
}

// Every admin request names the branch this tab edits (main sends nothing).
installBranchRequestHeaders()

const root = createRoot(rootElement, {
  onCaughtError: (error, info) => {
    handleRootError('react-root:caught', error, info, null)
  },
  onUncaughtError: (error, info) => {
    handleRootError(
      'react-root:uncaught',
      error,
      info,
      'Unhandled render error',
    )
  },
  onRecoverableError: (error, info) => {
    handleRootError('react-root:recoverable', error, info, null)
  },
})

// Force the initial mount to be SYNCHRONOUS. By default React 19 schedules
// the first render in concurrent mode and the scheduler defers the commit
// behind the browser's other work — we measured a consistent 280 ms gap
// between `createRoot().render(...)` completing and the first `useEffect`
// callback firing, even on a localhost build with all chunks already in
// memory. `flushSync` forces the entire initial render + commit to happen
// inside this microtask, so the user's first interaction-ready paint is
// not deferred behind layout / paint / prefetch work.
//
// Trade-off: this turns the initial render into a single blocking task.
// In practice the eager bundle is small enough (~96 KB gz / 36 ms of
// actual JS execution per our CPU profile) that the user does not see a
// frame drop. Subsequent renders still run in concurrent mode.
// Authenticated visitors get a best-effort shell preload before React mounts,
// but the mount itself must never wait on it. `server/static.ts` sets
// `window.__instaticAuthed` from the presence of the HttpOnly session cookie,
// not from a DB-validated session. If that cookie is stale or a network path
// stalls this chunk request, blocking here leaves the raw HTML loader on
// screen forever because React has not mounted yet.
function preloadAuthenticatedShellChunk(): void {
  if (typeof window === 'undefined') return
  if ((window as unknown as { __instaticAuthed?: number }).__instaticAuthed !== 1) return

  void import('./AuthenticatedAdmin').catch((err: unknown) => {
    console.warn('[admin-shell] Authenticated shell preload failed:', err)
  })
}

preloadAuthenticatedShellChunk()

// Keep this entry as an async module without waiting on network work. Rolldown
// otherwise hoists shared admin modules into the eager `index` chunk, which
// defeats the narrow boot chunks enforced by the bundle-size architecture gate.
await Promise.resolve()

flushSync(() => {
  root.render(
    <StrictMode>
      <ErrorBoundary location="admin-shell">
        <Router>
          <AdminRoutes />
        </Router>
        <AdminZoomGuard />
        <AdminContextMenuGuard />
      </ErrorBoundary>
      <ToastProvider />
    </StrictMode>,
  )
})
