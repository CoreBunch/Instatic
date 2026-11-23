# useAsyncResource

Canonical hook for single-resource async loads in admin screens.

`useAsyncResource` runs a loader on mount and whenever its dependencies change, tracks `{ data, loading, error }`, discards superseded responses, and exposes a stable `refresh()`. It replaces the hand-rolled `useState + useEffect + let cancelled = false + try/catch/finally` boilerplate that each workspace hook otherwise reimplements with its own cancellation-flag spelling and error-message wording.

---

## TL;DR

- **Use it** for a single logical load that fills `{ data, loading, error }`.
- **Don't use it** for optimistic collections, multi-fetch orchestrators, module-level cached loads, or non-fetch effects — see below.
- Loader receives an `AbortSignal` — forward it to `apiRequest({ signal })` to abort on unmount or refresh.
- `deps` works like a `useEffect` dependency array. Pass everything the loader closes over.
- `refresh()` identity is stable — safe in `useEffect` dependency arrays.

---

## The shape

```ts
// src/admin/lib/useAsyncResource.ts

export interface AsyncResource<T> {
  data: T | null       // null before the first successful load
  loading: boolean     // true while a load is in flight (including initial mount)
  error: string | null // human-readable message from the most recent failed load
  refresh: () => void  // re-run the loader; stable identity across renders
}

export interface UseAsyncResourceOptions {
  fallbackError?: string  // message when a thrown value is not an Error; default: 'Something went wrong'
  swallowErrors?: boolean // when true, a failed load leaves data/error untouched
}

function useAsyncResource<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  deps: DependencyList,
  options?: UseAsyncResourceOptions,
): AsyncResource<T>
```

---

## Canonical usage

**Simple read-only resource:**

```tsx
// DataTableControl.tsx
const { data: tables, loading, error } = useAsyncResource<TableOption[]>(
  async () => {
    const items = await listCmsDataTables()
    return items.filter((t) => includeSystem || t.kind === 'data')
               .map((t) => ({ id: t.id, label: t.name || t.slug || t.id, kind: t.kind }))
  },
  [includeSystem],
  { fallbackError: 'Failed to load data tables.' },
)
```

**With `refresh()` after a mutation:**

```tsx
const { data: plugins, loading, error, refresh } = useAsyncResource(
  () => listInstalledPlugins(),
  [],
)

async function handleUninstall(id: string) {
  await uninstallPlugin(id)
  refresh()  // stable, safe in callbacks
}
```

**With `AbortSignal` forwarded to the persistence layer:**

```tsx
const { data } = useAsyncResource(
  (signal) => apiRequest('/api/cms/pages', { signal }),
  [],
)
```

**Seeding an edit form (render-time seed from `data`):**

When the resource is loaded the first time, you can seed form state from `data` at render time by reading it inside the component after the hook returns. See `PluginSettingsDialog` (`src/admin/pages/plugins/components/PluginSettingsDialog/PluginSettingsDialog.tsx`) for the canonical example.

**Silencing errors for dashboard widgets:**

```tsx
// Widget keeps showing a skeleton rather than an error state.
const { data: stats } = useAsyncResource(
  () => loadDashboardStats(),
  [],
  { swallowErrors: true },
)
```

---

## When NOT to use it

The following shapes are deliberately different from the single-resource pattern. Bending `useAsyncResource` to fit them makes things worse, not more consistent.

### Optimistic collections

A list that is locally mutated after load — items added optimistically, edited, or deleted before the server confirms — cannot use `useAsyncResource` because `data` is read-only. Once the initial load completes, mutations need to write back to state.

Pattern: hand-rolled `useState + useEffect` with `let cancelled = false`, where the state arrays are updated via setters after mutations.

Examples in the codebase:

- `MediaLibraryControl` (`src/admin/pages/site/property-controls/MediaLibraryControl.tsx`) — assets list is mutated by `handlePickFromModal` (prepends) and `viewerEditor` (`onAssetChanged` / `onAssetRemoved`). The tag-autocomplete palette derives from the live list.
- `useContentMediaPicker` (`src/admin/pages/content/`) — same mutable-list pattern.
- `MediaWidget` (`src/admin/pages/dashboard/widgets/`) — same.

### Multi-fetch orchestrators with shared error channels

Several independent loads gated by different flags, or a load that must NOT re-raise `loading` on refresh (so tab-switching doesn't flash skeletons), require explicit state for each resource.

`useAsyncResource` always sets `loading = true` at the start of each load — including `refresh()`. An orchestrator that needs `loading` to stay false after the initial load so optimistic saves don't flash skeleton states cannot use it.

Examples:

- `useUsersPageData` (`src/admin/pages/users/hooks/useUsersPageData.ts`) — loads role options for the Users workspace and allows optimistic role updates; `loading` flips false only after the first round-trip and never re-raises on `refresh()`. Also shares a single `error` channel for both load and mutation failures.
- `useContentWorkspace`, `useDataWorkspace`, `useMediaWorkspace`, `usePluginsWorkspace` — workspace orchestrators with per-fetch granular state.

### Module-level cached loads

A fetch that dedupes across component mounts and publishes into a shared store or cache should live at module scope, not inside a component lifecycle.

Examples: `useSiteSummary`, `BindingPickerPopover`.

### Event-driven and subscription effects

Non-GET effects (WebSocket subscriptions, activation side-effects, plugin runtime initialization) are not load-then-done; they stay open for the lifetime of the component.

Examples: `useInstalledEditorPlugins`, `AdminSectionNavigation`, `SpotlightRoot`.

### Non-fetch effects

rAF loops, debounced builders, dynamic module imports, boot orchestration, preference sync with debounced save, or a status poll that seeds an action state machine.

Examples: `BreakpointSelectionOverlay` (rAF loop), `useRuntimeScriptBuild` (debounced bundler), `PluginPageRenderer` (dynamic module import), `useAdminBoot` (`flushSync` paint timing), `useDashboardLayout` (pref-sync), `PublishButton` (status-→-action state machine).

---

## Implementation notes

- Uses `useEffectEvent` (React 19) for the async load callback, keeping the effect dependency array minimal (`[dependencyVersion, reloadCount]`) while always capturing the latest `loader`, `fallbackError`, and `swallowErrors`.
- `deps` changes are tracked inside the hook via a manual comparison (not via `useEffect` exhaustive deps) so the hook can trigger a re-run synchronously on the same render that observes changed deps, rather than one render later.
- Stale-response guard: two mechanisms in parallel — an `AbortController` signals the in-flight request, and a `cancelled` boolean discards state updates from a superseded closure. Either alone is enough; both together handle the case where the persistence helper ignores the signal.

---

## Related

- `src/admin/lib/useAsyncResource.ts` — source of truth
- `src/__tests__/editor-hooks/useAsyncResource.test.tsx` — unit tests
- `docs/editor.md` → "Cross-page primitives" — where this hook sits in the admin lib
- `docs/reference/typebox-patterns.md` — boundary validation patterns for the responses this hook loads
