/**
 * Router hooks + shared internals — companion to `./Router.tsx`.
 *
 * Why this file exists separately from `Router.tsx`
 * --------------------------------------------------
 * Vite's React Fast Refresh (via `react-refresh/only-export-components` lint
 * rule) requires that a file exports either ONLY components or ONLY non-
 * components — not a mix. Mixing breaks HMR for that file: any change forces
 * a full page reload instead of hot-swapping the component.
 *
 * Splitting components into `Router.tsx` and hooks/types/contexts into this
 * `.ts` file keeps Fast Refresh working when we tweak components.
 *
 * Public API is re-exported from `./index.ts`. Callers import:
 *
 *   import { useLocation, useNavigate, Link, Router } from '@admin/lib/routing'
 */

import { createContext, use } from 'react'

// ---------------------------------------------------------------------------
// Types — exported for both this file's hooks and router.tsx's components.
// ---------------------------------------------------------------------------

export interface Location {
  pathname: string
  search: string
}

interface NavigateOptions {
  replace?: boolean
}

export interface NavigateFn {
  (to: string, options?: NavigateOptions): void
}

interface RouteContextValue {
  /** params from the currently-matched <Route>, or empty object if none. */
  params: Record<string, string>
}

export interface RouterContextValue {
  location: Location
  navigate: NavigateFn
}

// ---------------------------------------------------------------------------
// Contexts + the custom event navigate dispatches.
// router.tsx's components consume these via the public hooks below; only
// router.tsx's `<Router>` / `<MemoryRouter>` PROVIDE them.
// ---------------------------------------------------------------------------

export const RouterContext = createContext<RouterContextValue | null>(null)
export const RouteContext = createContext<RouteContextValue>({ params: {} })

// Custom event the navigate functions dispatch so useSyncExternalStore picks
// up pushState/replaceState (which don't fire popstate natively).
export const LOCATION_CHANGE_EVENT = 'instatic:locationchange'

export function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof window.history !== 'undefined'
}

// ---------------------------------------------------------------------------
// Path matching
// ---------------------------------------------------------------------------

interface CompiledPattern {
  regex: RegExp
  paramNames: string[]
}

function compilePattern(pattern: string): CompiledPattern {
  const paramNames: string[] = []
  const escaped = pattern
    .replace(/\/+$/, '')
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) {
        paramNames.push(segment.slice(1))
        return '([^/]+)'
      }
      // `*` segment — wildcard matching anything (including further slashes).
      // Used for catch-all routes (`path="*"`, `path="/admin/*"`) so unknown
      // URLs can redirect instead of <Routes> rendering an empty tree.
      if (segment === '*') {
        return '.*'
      }
      return segment.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')
    })
    .join('/')
  // Tolerate trailing slash; require full match.
  const regex = new RegExp(`^${escaped || '/'}/?$`)
  return { regex, paramNames }
}

export function matchPath(
  pattern: string,
  pathname: string,
): { params: Record<string, string> } | null {
  const compiled = compilePattern(pattern)
  const match = compiled.regex.exec(pathname)
  if (!match) return null
  const params: Record<string, string> = {}
  for (let i = 0; i < compiled.paramNames.length; i++) {
    const name = compiled.paramNames[i]
    const value = match[i + 1]
    if (value !== undefined) params[name] = decodeURIComponent(value)
  }
  return { params }
}

// ---------------------------------------------------------------------------
// Public hooks
// ---------------------------------------------------------------------------

function useRouterContextOrThrow(): RouterContextValue {
  const ctx = use(RouterContext)
  if (!ctx) {
    throw new Error('Router hooks must be used inside <Router> or <MemoryRouter>')
  }
  return ctx
}

export function useInRouterContext(): boolean {
  return use(RouterContext) !== null
}

export function useLocation(): Location {
  return useRouterContextOrThrow().location
}

export function useNavigate(): NavigateFn {
  return useRouterContextOrThrow().navigate
}

export function useParams<T extends Record<string, string> = Record<string, string>>(): T {
  return use(RouteContext).params as T
}
