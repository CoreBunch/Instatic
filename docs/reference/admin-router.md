# Admin Router

Cookbook for the in-house router at `src/admin/lib/routing/`. Replaces `react-router-dom` for the admin app — a 4-component, 4-hook surface that covers everything the 10-route admin needs.

Use it for every internal admin navigation, including links rendered by the site editor. `src/core/` and `src/modules/` must not import it because they are shared engine / published-page code, not admin UI.

---

## TL;DR

- Components: `Router`, `MemoryRouter`, `Routes`, `Route`, `Navigate`, `Link`.
- Hooks: `useLocation`, `useNavigate`, `useParams`, `useInRouterContext`.
- Path matching: `matchPath(pattern, pathname)` (exported from the barrel) — supports static segments, `:param` placeholders, and `*` wildcard segments for catch-alls. No optional segments, no nested routes.
- Navigation uses `history.pushState` + a custom `instatic:locationchange` event so multiple components stay in sync without re-renders ping-ponging.
- React 19 `startTransition` wraps every navigation so Suspense boundaries can switch smoothly without flashing.
- Internal admin links use `<Link to="/admin/...">`; button-like admin navigation uses `useAdminNavigate()`.

---

## Imports

```ts
import {
  Router, MemoryRouter, Routes, Route, Navigate, Link,
  matchPath, useLocation, useNavigate, useParams, useInRouterContext,
} from '@admin/lib/routing'
```

Don't import from `react-router-dom`. It's removed from `package.json`.

---

## Mounting the router

`src/admin/main.tsx`:

```tsx
<Router>
  <AdminRoutes />
</Router>
```

`Router` registers a global `popstate` listener and bridges `history.pushState` / `replaceState` into a `instatic:locationchange` event. `MemoryRouter` is for tests — same surface, no DOM history.

---

## The route table

```tsx
// src/admin/router.tsx
<Routes>
  <Route path="/"                                element={<Navigate to="/admin/dashboard" replace />} />
  <Route path="/admin"                           element={<Navigate to="/admin/dashboard" replace />} />
  <Route path="/admin/dashboard"                 element={<AdminEntry section="dashboard" />} />
  <Route path="/admin/site"                      element={<AdminEntry section="site" />} />
  <Route path="/admin/content"                   element={<AdminEntry section="content" />} />
  <Route path="/admin/data"                      element={<AdminEntry section="data" />} />
  <Route path="/admin/media"                     element={<AdminEntry section="media" />} />
  <Route path="/admin/plugins"                   element={<AdminEntry section="plugins" />} />
  <Route path="/admin/users"                     element={<AdminEntry section="users" />} />
  <Route path="/admin/ai"                        element={<AdminEntry section="ai" />} />
  <Route path="/admin/account"                   element={<AdminEntry section="account" />} />
  <Route path="/admin/plugins/:pluginId/:pageId" element={<AdminEntry section="pluginPage" />} />
  <Route path="/admin/*"                         element={<Navigate to="/admin/dashboard" replace />} />
</Routes>
```

Patterns:

- Static segments: `/admin/dashboard`
- Parameter segments: `:pluginId`, `:pageId`
- Wildcard segment: `*` matches anything, including further slashes (`*`, `/admin/*`) — used for catch-all routes
- No optional segments, no nested routes

The router walks `Routes` children top-to-bottom; the first matching `Route` wins. Order matters when patterns could overlap — the `*` catch-all MUST stay last or it shadows every route after it.

---

## `<Route>`

```tsx
<Route path="/admin/site" element={<AdminEntry section="site" />} />
```

`Route` is **declarative metadata** — it doesn't render its `element` itself. `Routes` reads its children, picks the matching one, and renders that element with `RouteContext` populated for `useParams`.

`Route` always returns `null` if rendered standalone (so it's safe to put inside conditionals; if you forget to wrap it in `Routes`, nothing renders).

---

## `<Routes>`

Walks its `<Route>` children in order, finds the first whose `path` matches the current `pathname`, and renders that route's `element`. Provides `RouteContext` so `useParams` works.

```tsx
<Routes>
  <Route path="/" element={<Navigate to="/admin/dashboard" replace />} />
  <Route path="/admin/dashboard" element={<Dashboard />} />
  {/* ... */}
</Routes>
```

If no route matches, `Routes` renders `null` — which paints a blank page. That's why `AdminRoutes` ends with a `path="/admin/*"` catch-all redirecting to `/admin/dashboard`: an unknown admin URL (typo, stale deep link, `/admin/login`) shows the login form when unauthenticated and the dashboard otherwise, never an empty tree. The catch-all is deliberately scoped to `/admin/*` — public-site 404s are handled by the publish pipeline (NotFound template) and must never be claimed by the admin SPA.

---

## `<Navigate>`

Imperative-style redirect rendered as a component. Fires once on mount and triggers navigation.

```tsx
<Navigate to="/admin/dashboard" replace />
```

| Prop      | Default | Behavior                                                |
|-----------|---------|---------------------------------------------------------|
| `to`      | -       | Target path                                             |
| `replace` | `false` | Use `history.replaceState` instead of `pushState`       |

Used for index redirects (`/` → `/admin/dashboard`) and access-denied redirects (`<Navigate to={firstAccessibleWorkspace} replace />`).

---

## `<Link>`

```tsx
<Link to="/admin/media" className={styles.navLink}>Media</Link>
```

Renders an `<a href={to}>` that intercepts the click and navigates via the router (no page reload). Falls back to native navigation on:

- Modifier keys (cmd / ctrl / shift / alt) — open in a new tab
- Non-left clicks
- `target="_blank"`

Pass any standard anchor props (`className`, `aria-*`, `style`, etc.).

---

## Hooks

### `useLocation()`

```ts
const { pathname, search, hash } = useLocation()
```

Returns the current location. Re-renders the component on every navigation.

### `useNavigate()`

```ts
const navigate = useNavigate()

navigate('/admin/site')                // push
navigate('/admin/site', { replace: true })   // replace
```

Returns a function. Calling it triggers a navigation through `startTransition` (so React 19 can defer Suspense fallbacks smoothly).

### `useParams<T>()`

```ts
const { pluginId, pageId } = useParams<{ pluginId: string; pageId: string }>()
```

Returns the params from the matched `Route`'s pattern. The type parameter is a hint — the runtime returns `Record<string, string>` always.

### `useInRouterContext()`

```ts
const inRouter = useInRouterContext()
if (!inRouter) {
  // Render a fallback for use outside the router (e.g. test harness)
}
```

Used by `AuthenticatedAdmin` to render a non-redirect fallback when access is denied and there's no router context (e.g. unit tests).

---

## `useAdminNavigate`

`src/admin/lib/useAdminNavigate.ts` wraps `useNavigate` with a `document.startViewTransition` + `flushSync` pattern that gives admin navigation its fade-in/fade-out feel. The function signature is `(to: string) => void` — pass the full path:

```ts
const navigate = useAdminNavigate()
navigate('/admin/site')
navigate('/admin/ai')
navigate('/admin/plugins/acme.x/dashboard')
```

Prefer `useAdminNavigate` over raw `useNavigate` for programmatic navigation inside admin components (toolbar dropdowns, modals, panel buttons). `<Link>` is still better for anchor-based navigation where middle-click / modifier-key semantics matter.

---

## Navigation lifecycle

```text
useNavigate()(path)
    │
    ▼
React.startTransition(() => {
    history.pushState(null, '', path)
    window.dispatchEvent(new Event(LOCATION_CHANGE_EVENT))
})
    │
    ▼
RouterContext subscribers re-read location.pathname
    │
    ▼
<Routes> picks the matching <Route>
    │
    ▼
<Suspense> shows the prior route until the next workspace chunk resolves
```

`startTransition` is the load-bearing piece — without it, navigating between workspaces flashes `<AppLoadingScreen>` during the lazy chunk load. With it, React keeps showing the previous workspace until the new chunk is ready, then commits.

---

## Path matching

`matchPath(pattern, pathname)`:

```ts
matchPath('/admin/plugins/:pluginId/:pageId', '/admin/plugins/acme.x/dashboard')
// → { params: { pluginId: 'acme.x', pageId: 'dashboard' } }

matchPath('/admin/dashboard', '/admin/site')
// → null
```

Rules:

- Static segments must match exactly.
- `:param` segments match any non-`/` token; the value lands in `params`.
- No optional, no wildcard, no regex.

If you need a wildcard, restructure the route tree — the admin shouldn't need one.

---

## The `LOCATION_CHANGE_EVENT`

`Router` listens on `window` for `popstate` and the custom `instatic:locationchange` event. The custom event fires whenever code calls `history.pushState` or `history.replaceState` via the router.

This pattern lets multiple components subscribe to navigation without React owning the source of truth — `history` IS the source of truth, and the event tells subscribers to re-read.

External code that wants to react to navigations can listen:

```ts
window.addEventListener('instatic:locationchange', () => {
  // ... re-read location
})
```

(In practice, prefer `useLocation()`.)

---

## Cookbook

### Add a new workspace route

1. Add the section to `AdminWorkspace` in `src/admin/workspace.ts`.
2. Add `<Route path="/admin/<section>" element={<AdminEntry section="<section>" />} />` in `src/admin/router.tsx`.
3. Add a `lazy(...)` + pre-warm import in `src/admin/AuthenticatedAdmin.tsx`.
4. Create `src/admin/pages/<section>/<Section>Page.tsx`.

See [docs/editor.md](../editor.md) → "Adding a new workspace".

### Conditional navigation in a component

```tsx
function MyComponent() {
  const navigate = useAdminNavigate()
  const handleSave = async () => {
    await saveSomething()
    navigate('/admin/content')
  }
  return <Button onClick={handleSave}>Save</Button>
}
```

### Read URL params

```tsx
function PluginPage() {
  const { pluginId, pageId } = useParams<{ pluginId: string; pageId: string }>()
  return <div>Plugin: {pluginId} · Page: {pageId}</div>
}
```

### Navigate from outside React (e.g. a command)

Spotlight commands receive `ctx.navigate` in `CommandContext`. They use it directly:

```ts
run: (ctx) => {
  ctx.navigate('/admin/media')
}
```

Don't call `window.location.href = '/admin/media'` — that triggers a full page reload.

### Link with query string

```tsx
<Link to={`/admin/data?table=${tableId}`}>Edit table</Link>
```

`useLocation()` returns `{ pathname, search, hash }` — read `search` for query strings. There's no `useSearchParams` helper today; parse with `new URLSearchParams(search)` directly.

### Test with `MemoryRouter`

```tsx
import { MemoryRouter, Routes, Route } from '@admin/lib/routing'

render(
  <MemoryRouter initialEntries={['/admin/dashboard']}>
    <Routes>
      <Route path="/admin/dashboard" element={<Dashboard />} />
    </Routes>
  </MemoryRouter>,
)
```

`MemoryRouter` doesn't touch `history` — perfect for unit tests.

---

## Forbidden patterns

| Pattern                                                          | Use instead                                          |
|------------------------------------------------------------------|------------------------------------------------------|
| `import { ... } from 'react-router-dom'`                         | `@admin/lib/routing`. The package isn't installed.   |
| Raw `<a href="/admin/...">` in admin UI                          | `<Link to="/admin/...">` or `useAdminNavigate()`.    |
| Router imports from `src/core/`                                  | Gated.                                               |
| Router imports from `src/modules/`                               | Gated.                                               |
| `window.location.href = '...'` for navigation                    | `useNavigate()` / `useAdminNavigate()` — full reloads kill the SPA state |
| `history.pushState` directly                                     | Use the router — it fires `instatic:locationchange` for you|
| Nested routes (`<Route path="/admin/site"><Route ...>...`)       | Flat route table only. Compose with workspace internal state. |
| Optional URL segments / wildcards                                 | Restructure the route tree.                          |
| Catch-all 404 route                                              | The admin has 9 known paths — invalid paths route to dashboard via the index redirect. |

---

## `@admin/lib/urlState` — query-string sync without route re-match

A companion module at `src/admin/lib/urlState/` provides URL state primitives for workspace selection state.

```ts
import { useInitialQueryParams, useUrlQuerySync } from '@admin/lib/urlState'
```

| Hook | Purpose |
|------|---------|
| `useInitialQueryParams()` | Returns the query params present at first mount (stable, read-once). |
| `useUrlQuerySync(params, opts?)` | Mirrors the given key→value map into the URL via `replaceState`. `null` values remove the key; unspecified keys are untouched. |

These hooks operate on `window.history.replaceState` directly and deliberately do **not** dispatch `instatic:locationchange` — query-string updates for selection state must never trigger a route re-match. Three workspaces use them: the site editor (`useSiteEditorUrlSync`), the Content workspace, and the Data workspace.

Full contract and URL shapes are documented in [docs/editor.md](../editor.md) → "URL state and workspace deep links".

---

## Related

- [docs/editor.md](../editor.md) — admin shell + router placement, URL state contract
- [docs/architecture.md](../architecture.md) — `/admin/*` namespace owned by the SPA
- [docs/features/spotlight.md](../features/spotlight.md) — Spotlight command navigation
- Source-of-truth files:
  - `src/admin/lib/routing/Router.tsx` — `Router`, `MemoryRouter`, `Routes`, `Route`, `Navigate`
  - `src/admin/lib/routing/routerHooks.ts` — `useLocation`, `useNavigate`, `useParams`, `useInRouterContext`, `matchPath`
  - `src/admin/lib/routing/index.ts` — barrel
  - `src/admin/lib/urlState/urlState.ts` — `useInitialQueryParams`, `useUrlQuerySync`
  - `src/admin/lib/useAdminNavigate.ts` — typed workspace navigation
  - `src/admin/router.tsx` — the route table
- Gate tests:
  - `src/__tests__/architecture/admin-router-usage.test.ts`
