/**
 * Tiny admin router — replaces react-router-dom for the admin app.
 *
 * What this provides
 * ------------------
 * - `<Router>`         browser router; subscribes to popstate + custom
 *                      'instatic:locationchange' event for pushState/replaceState
 * - `<MemoryRouter>`   in-memory router for tests; maintains its own
 *                      pathname/search state
 * - `<Routes>` /       declarative route matching, supports `:param`
 *   `<Route>`          segments. First match wins.
 * - `<Navigate>`       declarative redirect (effect-based push or replace)
 * - `<Link>`           anchor that calls history.pushState on left-click;
 *                      falls back to a plain anchor if no router context
 *
 * Hooks (`useLocation`, `useNavigate`, `useParams`, `useInRouterContext`)
 * live in `./routerHooks.ts` so Fast Refresh works for this components file.
 *
 * Why custom (not react-router-dom)
 * ----------------------------------
 * react-router-dom@7 ships ~30 KB gz on the *eager* cold path for an admin
 * with a small static route table. That's the worst kind of bundle bloat — features
 * we're not using (loaders, actions, nested layouts, data routers) shipped
 * to every visitor before the editor even mounts. This file replaces it with
 * only the routing features the admin actually uses.
 *
 * If/when we need data loaders or nested route layouts, this file can grow
 * incrementally — but every feature here is one we actually use.
 */

import {
  createElement,
  startTransition,
  use,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type AnchorHTMLAttributes,
  type MouseEvent,
  type ReactNode,
} from 'react'
import {
  LOCATION_CHANGE_EVENT,
  RouteContext,
  RouterContext,
  isBrowser,
  matchPath,
  useLocation,
  useNavigate,
  type Location,
  type NavigateFn,
  type RouterContextValue,
} from './routerHooks'

// ---------------------------------------------------------------------------
// Browser <Router>
// ---------------------------------------------------------------------------

function browserSubscribe(callback: () => void): () => void {
  if (!isBrowser()) return () => {}
  window.addEventListener('popstate', callback)
  window.addEventListener(LOCATION_CHANGE_EVENT, callback)
  return () => {
    window.removeEventListener('popstate', callback)
    window.removeEventListener(LOCATION_CHANGE_EVENT, callback)
  }
}

function getBrowserSnapshot(): string {
  if (!isBrowser()) return '/'
  return window.location.pathname + window.location.search
}

function getServerSnapshot(): string {
  return '/'
}

export function Router({ children }: { children: ReactNode }) {
  const snapshot = useSyncExternalStore(
    browserSubscribe,
    getBrowserSnapshot,
    getServerSnapshot,
  )

  const location: Location = (() => {
    const queryIndex = snapshot.indexOf('?')
    return queryIndex === -1
      ? { pathname: snapshot, search: '' }
      : {
          pathname: snapshot.slice(0, queryIndex),
          search: snapshot.slice(queryIndex),
        }
  })()

  const navigate: NavigateFn = (to, options) => {
    if (!isBrowser()) return
    const replace = options?.replace ?? false
    // Wrap the location-change dispatch in `startTransition` so React 19
    // treats the subsequent route render as a low-priority Transition:
    //
    //   - If the new route's lazy chunk hasn't loaded yet, React keeps
    //     showing the CURRENT page instead of swapping to the Suspense
    //     fallback. The fallback flash that previously happened on every
    //     nav click (Dashboard → Site, etc.) disappears entirely.
    //   - When the chunk resolves, React atomically swaps to the new
    //     page. The transition is invisible — the user perceives the
    //     navigation as instant.
    //
    // The history update itself stays synchronous; only the
    // `useSyncExternalStore` re-read (triggered by the event) runs
    // inside the transition.
    if (replace) {
      window.history.replaceState(null, '', to)
    } else {
      window.history.pushState(null, '', to)
    }
    startTransition(() => {
      window.dispatchEvent(new Event(LOCATION_CHANGE_EVENT))
    })
  }

  const value: RouterContextValue = { location, navigate }

  return (
    <RouterContext.Provider value={value}>{children}</RouterContext.Provider>
  )
}

// ---------------------------------------------------------------------------
// <MemoryRouter> — for tests
// ---------------------------------------------------------------------------

export function MemoryRouter({
  children,
  initialEntries = ['/'],
}: {
  children: ReactNode
  initialEntries?: string[]
}) {
  const initial = initialEntries[initialEntries.length - 1] ?? '/'
  const [snapshot, setSnapshot] = useState<string>(initial)

  const location: Location = (() => {
    const queryIndex = snapshot.indexOf('?')
    return queryIndex === -1
      ? { pathname: snapshot, search: '' }
      : {
          pathname: snapshot.slice(0, queryIndex),
          search: snapshot.slice(queryIndex),
        }
  })()

  const navigate: NavigateFn = (to) => {
    // Same transition wrapping as <Router>'s navigate. Tests that assert
    // on Suspense fallback behavior get parity with production routing.
    startTransition(() => {
      setSnapshot(to)
    })
  }

  const value: RouterContextValue = { location, navigate }

  return (
    <RouterContext.Provider value={value}>{children}</RouterContext.Provider>
  )
}

// ---------------------------------------------------------------------------
// <Routes> / <Route>
//
// <Route> is a marker component — it carries `path` + `element` props but
// renders nothing on its own. <Routes> walks its children, matches the first
// path against the current location, and renders that <Route>'s element with
// the params context populated.
// ---------------------------------------------------------------------------

interface RouteProps {
  path: string
  element: ReactNode
}

export function Route(_props: RouteProps): null {
  // Marker only — <Routes> reads props from the React element directly.
  return null
}

interface RoutesProps {
  children: ReactNode
}

export function Routes({ children }: RoutesProps) {
  const { pathname } = useLocation()

  // Run the match each render. We don't memoize: `children` is the result of
  // JSX and gets a new reference every parent render, so the cache would
  // miss every time anyway. Route matching is a regex against the small admin
  // route table, so it stays cheap.
  const list = collectRouteChildren(children)
  let matched: { element: ReactNode; params: Record<string, string> } | null = null
  for (const route of list) {
    const result = matchPath(route.path, pathname)
    if (result) {
      matched = { element: route.element, params: result.params }
      break
    }
  }

  if (!matched) return null
  return (
    <RouteContext.Provider value={{ params: matched.params }}>
      {matched.element}
    </RouteContext.Provider>
  )
}

function collectRouteChildren(children: ReactNode): RouteProps[] {
  const out: RouteProps[] = []
  const arr = Array.isArray(children) ? children : [children]
  for (const child of arr) {
    if (
      typeof child === 'object'
      && child !== null
      && 'type' in child
      && (child as { type?: unknown }).type === Route
    ) {
      const props = (child as { props: RouteProps }).props
      out.push(props)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// <Navigate>
// ---------------------------------------------------------------------------

export function Navigate({ to, replace = false }: { to: string; replace?: boolean }) {
  const navigate = useNavigate()
  // Use a ref so the effect runs exactly once even under StrictMode double-invoke.
  const fired = useRef(false)
  useEffect(() => {
    if (fired.current) return
    fired.current = true
    navigate(to, { replace })
  }, [navigate, to, replace])
  return null
}

// ---------------------------------------------------------------------------
// <Link>
// ---------------------------------------------------------------------------

interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  to: string
  replace?: boolean
  children?: ReactNode
}

export function Link({ to, replace = false, onClick, children, ...rest }: LinkProps) {
  // Calling useNavigate without router context throws — only call when
  // we have one. Falling back to a plain anchor preserves SSR / pre-mount
  // rendering in places that render outside a Router (rare but safe).
  const ctx = use(RouterContext)
  const inRouter = ctx !== null
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event)
    if (event.defaultPrevented) return
    // Let the browser handle non-left-clicks, modifier-clicks, target=_blank,
    // and external URLs — same semantics as react-router-dom's <Link>.
    if (event.button !== 0) return
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    if (rest.target && rest.target !== '_self') return
    if (!inRouter || !ctx) return
    event.preventDefault()
    ctx.navigate(to, { replace })
  }

  return createElement('a', { ...rest, href: to, onClick: handleClick }, children)
}
