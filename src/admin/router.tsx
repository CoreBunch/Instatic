import { Suspense } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { Navigate, Route, Routes } from './lib/routing'
import { useLocation } from './lib/routing'
import { ErrorBoundary } from '@ui/components/ErrorBoundary'
import { AppLoadingScreen } from './AppLoadingScreen'
import AdminEntry from './AdminEntry'

// AdminEntry is eager-imported (not behind `React.lazy`) so the cold load
// path does not require Suspense resolution before the first contentful
// commit. Cold-load measurements showed React 19's concurrent scheduler
// taking ~280 ms between the lazy chunk resolving and the commit being
// painted, which is what flushSync(root.render(...)) cannot bypass —
// flushSync only synchronises the FIRST render, and the lazy resolution
// produces a SECOND render that goes through the concurrent scheduler.
// Eager import folds AdminEntry's tiny chunk (10 KB gz) into the main
// entry; the heavy `AuthenticatedAdmin` chunk is still lazy and only
// loads post-login.
//
// Net effect on cold /admin: useEffect fires ~290 ms earlier, LCP drops
// proportionally. See `.tmp/benchmarks/REPORT.md` for the measurements.
function withSuspense(element: ReactElement): ReactElement {
  // Suspense still wraps the route so any downstream `lazy()` boundaries
  // (e.g. AuthenticatedAdmin) have a fallback.
  return <Suspense fallback={<AppLoadingScreen />}>{element}</Suspense>
}

/**
 * Per-route error boundary. Resets when the pathname changes so navigating
 * away from a broken route automatically clears the failure state — the user
 * never gets "stuck" on an error page just because they tried to come back.
 *
 * Location tag intentionally collapses to "admin-route" rather than embedding
 * the path: the architecture gate requires unique location strings per
 * placement, and we want a single boundary tag that covers every section.
 * The active pathname is surfaced via the toast body and the dev fallback.
 */
function RouteBoundary({ children }: { children: ReactNode }) {
  const { pathname } = useLocation()
  return (
    <ErrorBoundary location="admin-route" resetKeys={[pathname]}>
      {children}
    </ErrorBoundary>
  )
}

function withRouteBoundary(element: ReactElement): ReactElement {
  return <RouteBoundary>{withSuspense(element)}</RouteBoundary>
}

export function AdminRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/admin/dashboard" replace />} />
      <Route path="/admin" element={<Navigate to="/admin/dashboard" replace />} />
      <Route path="/admin/dashboard" element={withRouteBoundary(<AdminEntry section="dashboard" />)} />
      <Route path="/admin/site" element={withRouteBoundary(<AdminEntry section="site" />)} />
      <Route path="/admin/content" element={withRouteBoundary(<AdminEntry section="content" />)} />
      <Route path="/admin/data" element={withRouteBoundary(<AdminEntry section="data" />)} />
      <Route path="/admin/media" element={withRouteBoundary(<AdminEntry section="media" />)} />
      <Route path="/admin/plugins" element={withRouteBoundary(<AdminEntry section="plugins" />)} />
      <Route path="/admin/users" element={withRouteBoundary(<AdminEntry section="users" />)} />
      <Route path="/admin/ai" element={withRouteBoundary(<AdminEntry section="ai" />)} />
      <Route path="/admin/tools/seo" element={withRouteBoundary(<AdminEntry section="seo" />)} />
      <Route path="/admin/account" element={withRouteBoundary(<AdminEntry section="account" />)} />
      <Route
        path="/admin/plugins/:pluginId/:pageId"
        element={withRouteBoundary(<AdminEntry section="pluginPage" />)}
      />
      {/* Catch-all for ADMIN paths only — an unknown /admin URL (typo, stale
          deep link, /admin/login) must never render an empty tree.
          Redirecting to the dashboard shows the login form when
          unauthenticated and the dashboard otherwise. Deliberately scoped to
          /admin/*: public-site 404s have their own treatment (the publish
          pipeline's NotFound template) and must never be swallowed by the
          admin SPA. MUST stay the last route: <Routes> takes the first match
          in declaration order. */}
      <Route path="/admin/*" element={<Navigate to="/admin/dashboard" replace />} />
    </Routes>
  )
}
