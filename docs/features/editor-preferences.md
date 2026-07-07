# Editor Preferences

Local UI preferences for the editor — auto-save behaviour, hover-preview gating, admin theme, UI text size, density, layers panel options, etc. Stored in `localStorage`, scoped to the device, never written to the site file.

The feature is **catalog-driven**: one declarative array drives the schema, the runtime defaults, and the Settings → Preferences UI. Adding a preference is two lines.

---

## TL;DR

- Source of truth: `PREFERENCE_CATALOG` in `src/admin/pages/site/preferences/catalog.ts`.
- Read from React: `useEditorPreference('autoSave')` / `useEditorSelectPreference('density')` / `useEditorAppearancePreferences()`.
- Read from non-React: `readEditorPreference('autoSave')` + `subscribeToEditorPrefsChanged(listener)`.
- Settings UI renders automatically from the catalog — no per-preference wiring.
- Storage: `localStorage["instatic-editor-prefs"]` (`EDITOR_PREFS_KEY`). `additionalProperties: true` on the schema keeps forward / backward compatibility silent.

### Adding a new preference

1. Append one entry to `PREFERENCE_CATALOG` in `src/admin/pages/site/preferences/catalog.ts`.
2. Read it with `useEditorPreference('your-id')` wherever you need it.

```ts
// catalog.ts — append:
{
  id: 'layersShowIcon',
  type: 'boolean',
  category: 'layers',
  label: 'Show module icon',
  description: 'Display the module type icon next to each layer row.',
  default: true,
}

// Use it:
import { useEditorPreference } from '@site/preferences/editorPreferences'
const showIcon = useEditorPreference('layersShowIcon')
```

The Settings panel renders the new toggle in the matching category. The `id` becomes a literal-typed string union via `as const`, so `useEditorPreference('typo')` is a compile error.

---

## Architecture

Three files, one source of truth.

```text
src/admin/pages/site/preferences/
├── catalog.ts                — declarative source of truth
├── editorPreferences.ts      — runtime: schema, IO, hook, event bus
└── (consumed by)
    src/admin/modals/Settings/sections/PreferencesSection.tsx
```

### `catalog.ts` — source of truth

A single `PREFERENCE_CATALOG` array lists every preference. Each entry declares everything required:

```ts
export const PREFERENCE_CATALOG = [
  {
    id: 'autoSave',
    type: 'boolean',
    category: 'editor',
    label: 'Auto-save',
    description: 'Automatically save the site every 30 seconds.',
    default: true,
  },
  // …
] as const satisfies ReadonlyArray<PreferenceDef>
```

Why a catalog (not hand-rolled per-preference code):

- **Settings UI auto-renders.** `PreferencesSection` iterates the catalog grouped by category. New preferences surface automatically.
- **One place to look.** Defaults, labels, descriptions, and valid ids all live together.
- **Type-safe ids.** `as const` preserves the literal union type. `useEditorPreference('layersShowTag')` compiles, `useEditorPreference('layersShowtag')` does not.
- **Defaults can't drift.** The schema and `DEFAULT_EDITOR_PREFS` are derived from the catalog at module load. There is no separate "registered" list to keep in sync.

The discriminated union has three branches:

```ts
interface BooleanPreferenceDef        { id, type: 'boolean',        category, label, description, default: boolean }
interface SelectPreferenceDef         { id, type: 'select',         category, label, description, options, default: string }
interface DynamicSelectPreferenceDef  { id, type: 'select-dynamic', category, label, description, optionsSource, default: string }

export type PreferenceDef =
  | BooleanPreferenceDef
  | SelectPreferenceDef
  | DynamicSelectPreferenceDef
```

A new preference type (e.g. `'number'`, `'colour'`) adds a branch to this union, one runtime read/set/hook in `editorPreferences.ts`, and one matching row component in `PreferencesSection.tsx`.

### `editorPreferences.ts` — runtime

Three layers:

**1. Schema and defaults — derived**

```ts
const schemaFields: Record<string, ReturnType<typeof Type.Optional>> = {}
for (const def of PREFERENCE_CATALOG) {
  if (def.type === 'boolean') schemaFields[def.id] = Type.Optional(Type.Boolean())
}
export const EditorPrefsSchema = Type.Object(schemaFields, { additionalProperties: true })
export const DEFAULT_EDITOR_PREFS = /* same loop, building the defaults object */
```

`additionalProperties: true` means an older client reading prefs written by a newer build does not crash on unknown fields — it ignores them.

**2. Generic IO**

```ts
export function readEditorPreference(id: BooleanPreferenceId): boolean
export function setEditorPreference(id: BooleanPreferenceId, value: boolean): void
```

Both go through `parseJsonWithFallback(EditorPrefsSchema, …)` so corrupt or partial localStorage falls back to defaults instead of throwing.

**3. Event bus + React hooks**

```ts
// Event bus — for non-React consumers (e.g. usePersistence's auto-save scheduler)
export function subscribeToEditorPrefsChanged(listener: () => void): () => void
export function notifyEditorPrefsChanged(): void

// React — preferred path for components.
// One hook per preference type so each callsite stays type-safe.
export function useEditorPreference(id: BooleanPreferenceId): boolean
export function useEditorSelectPreference(id: SelectPreferenceId): string
```

The event bus listens to two things:

- **Same-tab updates** — `setEditorPreference` dispatches a custom event that all hook instances pick up.
- **Cross-tab updates** — the browser's native `storage` event re-fires the listeners when another tab writes the same key, so two editor windows stay in sync.

The hook is intentionally one-preference-per-call. Multiple prefs in one component is multiple `useEditorPreference()` calls — React's dependency tracking stays trivial and re-renders are scoped to the prefs the component actually reads.

### `PreferencesSection.tsx` — auto-rendered Settings UI

```tsx
const groups = preferencesByCategory()

return groups.map((group) => (
  <section key={group.id}>
    <h4>{group.label}</h4>
    {group.preferences.map((pref) => <PreferenceRow key={pref.id} pref={pref} />)}
  </section>
))
```

`PreferenceRow` switches on `pref.type` and dispatches to the right concrete row component. A new preference type adds a branch here and a matching row component.

### Categories

Categories are declared in the catalog itself:

```ts
export const PREFERENCE_CATEGORIES = [
  { id: 'editor',     label: 'Editor' },
  { id: 'canvas',     label: 'Canvas',          description: '…' },
  { id: 'layers',     label: 'Layers panel',    description: '…' },
  { id: 'properties', label: 'Properties panel' },
  { id: 'spotlight',  label: 'Command palette', description: '…' },
]
```

Order here is the rendering order in the Preferences screen. Categories without any preferences are skipped automatically.

### Dynamic select options

`'select-dynamic'` preferences resolve their options at render time from runtime state. The declared source `'site.breakpoints'` is used by `defaultBreakpoint`. Each source maps to a small hook in `PreferencesSection.tsx`:

```ts
function useDynamicSelectOptions(source: DynamicOptionsSource) {
  const breakpoints = useEditorStore((state) => state.site?.breakpoints)
  if (source === 'site.breakpoints') {
    if (!breakpoints) return EMPTY_OPTIONS
    return breakpoints.map((bp) => ({ value: bp.id, label: bp.label }))
  }
  return EMPTY_OPTIONS
}
```

A new source is one branch here plus a new value in the `DynamicOptionsSource` union in `catalog.ts`.

When the persisted value is no longer in the dynamic option list (e.g. user previously picked a `wide` breakpoint, then opened a site without it), the dropdown still shows the stored value with a `(not in current site)` suffix so the mismatch is visible. The runtime reader (`readEditorSelectPreference`) returns the stored string regardless — consumers (e.g. `applyDefaultBreakpointPreference` in `usePersistence.ts`) decide whether to apply it or fall back.

**`defaultBreakpoint` has two effects on load.** `applyDefaultBreakpointPreference` sets `activeBreakpointId` (the editing context) when the loaded site has a matching breakpoint. Setting the active breakpoint alone does *not* move the canvas — it always mounts at pan `(0, 0)`, which shows the left-most (narrowest) frame. So `CanvasRoot` runs an effect (keyed on `canvasPage.id`) that pans the canvas to horizontally center the active frame (top aligned just below the viewport top), via `useCanvas().centerOnBreakpointFrame` and the pure `panToCenterBreakpointFrame` geometry in `canvasDomGeometry.ts`. This is the spatial half of "Which viewport context the canvas focuses on when a site is opened."

Because the effect keys on the document id, it also re-centers when the active document changes — switching pages or entering/leaving a Visual Component — so jumping from a long page you'd scrolled down to a shorter one brings the active frame back into view instead of leaving it panned off-screen. The current zoom is preserved; only the pan moves. Edits to the same document do **not** re-center (Mutative returns a new page object per edit, but the id is stable), and breakpoint switches within a document (toolbar, node clicks) also keep the designer's place. The retry that waits for the per-frame iframes to lay out uses `setTimeout`, not `requestAnimationFrame`: rAF only fires while the tab is painting, so a centering scheduled while the editor is backgrounded would otherwise silently never run.

**The loading skeleton has two phases.** While the editor-body chunk itself lazy-loads, `AdminCanvasLayout` paints a lightweight shell fallback using the shared canvas-frame skeletons. That fallback keeps cold Site loads from showing only the toolbar over an empty workspace, but it does not import the real canvas, sidebars, DnD context, modules, or panel graph. Once `CanvasRoot` mounts, `CanvasTransformLayer` owns loading state: while page data loads, it renders skeleton frames (`canvas-loading-frame-<id>`) instead of real ones. The same centering effect runs during this phase (when `canvasPage` is still null) and centers the skeleton for the `defaultBreakpoint` *preference* — i.e. what `activeBreakpointId` will resolve to once the site loads — so `centerOnBreakpointFrame` matches both the real wrapper and its loading skeleton. The result is an immediate visual placeholder on cold load, followed by the pannable skeleton/real content sharing the same centered position.

---

## Reading preferences from non-React code

Some call sites are not React components — `usePersistence.ts`'s auto-save scheduler is one example. They use the imperative API:

```ts
import {
  readAutoSavePreference,
  readAutoSaveDelayMs,
  readEditorSelectPreference,
  subscribeToEditorPrefsChanged,
} from '@site/preferences/editorPreferences'

// Read once at setup time
const enabled = readAutoSavePreference()
const delayMs = readAutoSaveDelayMs()

// React to changes
const unsub = subscribeToEditorPrefsChanged(() => {
  scheduleAutoSave()
})
```

Named convenience wrappers (`readAutoSavePreference`, `readHoverPreviewPreference`, `readAutoSaveDelayMs`) sit on top of the generic getters for one reason:

They self-document at the call site — `readAutoSavePreference()` reads better than `readEditorPreference('autoSave')`.

When a new preference needs an imperative reader, add a similarly-named wrapper in `editorPreferences.ts`. They're one-liners.

### Imperative settings via `setEditorPreference` / `setEditorSelectPreference`

Both setters dispatch the change event so all hook consumers re-render and the bus listeners (`usePersistence.ts`) re-evaluate. They're available outside React for migration scripts, plugin defaults, or one-shot programmatic toggles, but the typical setter path is the Settings UI.

---

## Storage shape

```jsonc
// localStorage["instatic-editor-prefs"]
{
  "autoSave": true,
  "hoverPreview": false,
  "theme": "light",
  "density": "comfortable",
  "textScale": "large",
  "layersShowTag": true,
  "layersShowClasses": true
}
```

Missing fields fall back to the catalog default. Unknown fields are preserved on round-trip (forward-compat). The storage key is exported as `EDITOR_PREFS_KEY` so tests and tooling can clear it without hardcoding the literal.

---

## Testing

Two tests cover the catalog-driven UI:

- `src/__tests__/settings/settingsSections.test.tsx` — renders `PreferencesSection` in isolation and asserts one switch per boolean catalog entry, each by name, plus one combobox per select/select-dynamic catalog entry. Adding a boolean preference: (1) increment the switch `toHaveLength(N)` count and (2) add a `getByRole('switch', { name: /your label/i })` assertion. Adding a select preference: increment the combobox count and assert the new combobox label.
- `src/__tests__/settings/settingsModal.test.tsx` — renders the full `SettingsModal` and asserts the overall count of switches in the Preferences section (`expect(switches.length).toBe(N)`), plus `pref-${id}` ids and `htmlFor` linkage for auto-rendered rows. Adding a boolean preference: increment the count assertion only.
- `src/__tests__/settings/editorAppearancePreferences.test.ts` covers the global appearance defaults, persistence, and document-root data attributes used by theme/text-size/density token scopes.

Adding a non-boolean (select / select-dynamic) preference leaves the switch counts alone, but the combobox count and label assertions should move with the catalog.

---

## Currently shipping preferences

The Settings → Preferences screen renders this list automatically from the catalog.

| Category         | Id                          | Type                 | Default     | Wired in                                       |
|------------------|-----------------------------|----------------------|-------------|------------------------------------------------|
| Editor           | `autoSave`                  | boolean              | `true`      | `usePersistence.ts`                            |
| Editor           | `autoSaveDelay`             | select (5s/15s/30s/60s/5min) | `'30'` | `usePersistence.ts` (`readAutoSaveDelayMs`) |
| Editor           | `hoverPreview`              | boolean              | `true`      | `ClassPicker.tsx`, `SpacingBoxControl.tsx`     |
| Editor           | `confirmBeforeDelete`       | boolean              | `false`     | `ConfirmDeleteProvider`                        |
| Editor           | `theme`                     | select (dark / light) | `'dark'`   | `data-editor-theme` on the document + layout roots |
| Editor           | `density`                   | select (compact / comfortable) | `'compact'` | `data-editor-density` on the document + layout roots |
| Editor           | `textScale`                 | select (small / default / large / extra-large) | `'default'` | `data-editor-text-scale` on the document + layout roots |
| Canvas           | `defaultBreakpoint`         | select-dynamic (`site.breakpoints`) | `'desktop'` | `applyDefaultBreakpointPreference` |
| Canvas           | `dimInactiveBreakpoints`    | boolean              | `true`      | `CanvasRoot.tsx`                               |
| Layers panel     | `layersShowIcon`            | boolean              | `true`      | `TreeNode.tsx`                                 |
| Layers panel     | `layersShowTag`             | boolean              | `true`      | `TreeNode.tsx`                                 |
| Layers panel     | `layersShowClasses`         | boolean              | `true`      | `TreeNode.tsx`                                 |
| Layers panel     | `layersAutoExpandSelected`  | boolean              | `true`      | `DomPanel.tsx` selection effect                |
| Layers panel     | `layersSmoothScroll`        | boolean              | `true`      | `DomPanel.tsx` scroll handler                  |
| Properties panel | `propertiesSmoothScroll`    | boolean              | `true`      | `StyleSurface.tsx` + `PropertiesPanel.tsx`     |
| Properties panel | `propertiesSectionsExpanded`| boolean              | `true`      | `StyleSectionsEditor.tsx`, `StyleSurface.tsx`, `CustomPropertiesSection.tsx` |
| Command palette  | `spotlightTelemetryEnabled` | boolean              | `false`     | command palette usage tracking                  |

### Confirm-before-delete flow

`confirmBeforeDelete` runs through a single shared `<ConfirmDeleteProvider/>` mounted in `AdminCanvasLayout`. Components call `useConfirmDelete()` and pass a `commit` callback:

```tsx
const confirmDelete = useConfirmDelete()

confirmDelete({
  title: 'Delete layer?',
  description: `${displayName} and any of its children will be removed.`,
  commit: () => deleteNode(nodeId),
})
```

When the preference is on, the provider mounts a small `<ConfirmDeleteDialog/>` and only runs `commit` after user confirmation. When off, `commit` runs immediately. The hook falls back to direct execution when used outside a provider (e.g. unit tests rendering a single panel in isolation), so test fixtures don't need to wrap in the provider.

### Hover-preview gate — shared across panels

The `hoverPreview` preference covers **every** transient hover-driven canvas preview the Properties panel exposes:

- `ClassPicker` — hovering a class suggestion temporarily applies it to the selected node.
- `SpacingBoxControl` — hovering a token in the spacing autocomplete dropdown previews the resolved value on the active class.
- Any future variable / token autocomplete in other property controls **must** opt into the same gate so users have one place to control hover behaviour.

The convention for new controls:

```tsx
const hoverPreviewEnabled = useEditorPreference('hoverPreview')

const previewOnHover = useCallback((value: string) => {
  if (!hoverPreviewEnabled) return
  applyTransientPreview(value)
}, [hoverPreviewEnabled, …])

// Defensive: clear any active preview if the pref toggles off mid-flight
// (cross-tab edit, Settings dropdown, etc.).
useEffect(() => {
  if (!hoverPreviewEnabled) clearPreview()
}, [hoverPreviewEnabled, clearPreview])
```

Notes:

- Only **hover-triggered** previews are gated. Live as-you-type previews (e.g. `previewDraft` in `SpacingBoxControl`) are NOT gated — they reflect an explicit edit the user is making.
- Clearing the preview on any code path (commit, mouse-leave, menu close, pref-off effect) always runs unconditionally so a stale preview never sticks around.

### Appearance attributes

`AdminEntry` and the authenticated admin layouts read `useEditorAppearancePreferences()`. The hook applies the current appearance values to `document.documentElement`, while each layout also mirrors them onto its root `<div>`:

- `data-editor-theme="dark"` (default) or `"light"` drives global admin token scopes in `src/styles/globals.css`.
- `data-editor-density="compact"` (default) or `"comfortable"` drives spacing/height overrides for dense surfaces.
- `data-editor-text-scale="small" | "default" | "large" | "extra-large"` remaps the global `--text-*` scale without changing spacing density.

The document-level attributes are required because many admin surfaces are portaled to `document.body` (select menus, context menus, tooltips, modals, toasts). The layout-level attributes avoid a first-paint mismatch for authenticated pages before the effect writes the document attributes.

Surfaces that respond to density use scoped `:global([data-editor-density='comfortable'])` selectors in their CSS module to override their default values:

```css
/* TreeRow.module.css */
.row {
    --tree-row-h: 28px;          /* compact default */
    height: var(--tree-row-h);
}
:global([data-editor-density='comfortable']) .row {
    --tree-row-h: 36px;
    font-size: 12px;
}
```

Adding density support to a new surface is two CSS lines. Theme and text-size support should usually require no component CSS; use the global `--bg-*`, `--text-*`, `--border*`, `--overlay-*`, and `--space-*` tokens.

---

## Renaming or dropping a preference

- **Renaming** a preference id requires updating its storage key handling at the same time — the schema's `additionalProperties: true` keeps the old data harmless in storage, but reads using `readEditorPreference('oldId')` return the catalog default for a missing id.
- **Dropping** a preference is safe: `additionalProperties: true` lets stale fields linger silently in users' `localStorage` without any cleanup step.

---

## Related

- [docs/editor.md](../editor.md) — admin / editor architecture
- [docs/reference/typebox-patterns.md](../reference/typebox-patterns.md) — `parseJsonWithFallback` and the soft-boundary pattern
- Source-of-truth files:
  - `src/admin/pages/site/preferences/catalog.ts` — `PREFERENCE_CATALOG`, `PREFERENCE_CATEGORIES`
  - `src/admin/pages/site/preferences/editorPreferences.ts` — schema, IO, hooks, event bus
  - `src/admin/modals/Settings/sections/PreferencesSection.tsx` — auto-rendered UI
  - `src/admin/pages/site/store/slices/uiSlice.ts` — `usePersistence.ts` and its prefs subscription
- Gate tests:
  - `src/__tests__/settings/settingsSections.test.tsx`
  - `src/__tests__/settings/settingsModal.test.tsx`
