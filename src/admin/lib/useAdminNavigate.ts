/**
 * `useAdminNavigate` — soft-navigation helper for the admin shell.
 *
 * Wraps the in-house router's `useNavigate` with the cross-page
 * `document.startViewTransition` + `flushSync` pattern that gives admin
 * routes their fade-in/fade-out feel. Replaces the duplicated logic that
 * previously lived only inside `RouterAdminRouteLink` so non-link surfaces
 * (toolbar dropdowns, modals, command palette, …) get the same treatment.
 *
 * Why a hook and not a wrapper component? Two reasons:
 *
 *   1. Anchor-based wrappers (like `RouterAdminRouteLink`) are great for
 *      <a href> semantics — middle-click opens a new tab, modifier keys
 *      survive, accessibility is free. Programmatic navigations (clicking
 *      a button inside a dropdown) don't have that semantic, so a function
 *      reference is the right primitive.
 *   2. Keeps the call site flat — `navigate('/admin/account')` is one
 *      line, no JSX wrapper.
 *
 * Must be used inside the admin `<Router>` — same constraint as the
 * underlying `useNavigate`. The CMS unconditionally mounts the router
 * around the admin tree, so this is the natural fit. In environments
 * without `document.startViewTransition` (older browsers, jsdom in tests),
 * the function falls back to a plain `navigate(to)` and the rest of the
 * shell still works.
 */
import { flushSync } from 'react-dom'
import { useNavigate } from './routing'

type AdminNavigate = (to: string) => void

export function useAdminNavigate(): AdminNavigate {
  const navigate = useNavigate()
  return (to) => {
    const startViewTransition = (document as Document & {
      startViewTransition?: (callback: () => void) => void
    }).startViewTransition
    if (typeof startViewTransition !== 'function') {
      void navigate(to)
      return
    }
    startViewTransition.call(document, () => {
      // `flushSync` forces React to commit the navigation synchronously so
      // the View Transitions API captures the after-state in the same
      // animation frame. Without it the transition snapshots the previous
      // page and you get a brief flash of the unchanged DOM.
      flushSync(() => {
        void navigate(to)
      })
    })
  }
}
