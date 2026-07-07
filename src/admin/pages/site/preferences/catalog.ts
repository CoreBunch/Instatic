/**
 * Preference catalog — declarative source of truth for every editor preference.
 *
 * Add a preference by appending an entry to `PREFERENCE_CATALOG`. The schema,
 * defaults, settings UI, and `useEditorPreference` hook all derive from this
 * list, so a new toggle is one entry.
 *
 * Why a catalog (vs hand-rolling each pref):
 *   - The Settings → Preferences screen renders directly from this list,
 *     grouped by `category`, so new prefs surface automatically with no
 *     PreferencesSection edits.
 *   - The hook signature stays type-safe: `useEditorPreference('layersShowTag')`
 *     compiles, but `useEditorPreference('typo')` does not, because the ID
 *     union is derived from this array via `as const`.
 *   - Defaults and validation are kept in lockstep — there's no way to ship
 *     a preference that's read by the UI but missing from the schema.
 *
 * The catalog is intentionally small in scope (boolean-only for now). Future
 * preference types (select, number, color) extend the `PreferenceDef` union
 * here; consumers add a matching branch in `editorPreferences.ts` and
 * `PreferencesSection.tsx`.
 */

// ---------------------------------------------------------------------------
// Categories
//
// One section in the Preferences screen per category. The order here is the
// order the sections render in (see PreferencesSection).
// ---------------------------------------------------------------------------

type PreferenceCategory = 'editor' | 'layers' | 'canvas' | 'properties' | 'spotlight'

const PREFERENCE_CATEGORIES: ReadonlyArray<{
  id: PreferenceCategory
  label: string
  description?: string
}> = [
  {
    id: 'editor',
    label: 'Editor',
  },
  {
    id: 'canvas',
    label: 'Canvas',
    description: 'How the canvas renders and reacts as you edit.',
  },
  {
    id: 'layers',
    label: 'Layers panel',
    description: 'Control what is shown next to each row in the DOM tree.',
  },
  {
    id: 'properties',
    label: 'Properties panel',
  },
  {
    id: 'spotlight',
    label: 'Command palette',
    description: 'Settings for the ⌘K command palette.',
  },
]

// ---------------------------------------------------------------------------
// Preference shapes
//
// One discriminated-union branch per supported preference type. Each branch
// declares its own default-value type so the catalog stays type-checked.
//
// Adding a new preference type:
//   1. Add a discriminated-union branch here.
//   2. Add a runtime branch in `editorPreferences.ts` (read/set/hook).
//   3. Add a row component in `PreferencesSection.tsx` and a `pref.type`
//      branch in the dispatcher.
// ---------------------------------------------------------------------------

interface BooleanPreferenceDef {
  id: string
  type: 'boolean'
  category: PreferenceCategory
  label: string
  description: string
  default: boolean
}

/**
 * A static select preference. Options are known at catalog declaration time.
 * Values are stored as strings; consumers parse them (e.g. to `Number`) where
 * needed. The `default` MUST be a value present in `options`.
 */
interface SelectPreferenceDef {
  id: string
  type: 'select'
  category: PreferenceCategory
  label: string
  description: string
  options: ReadonlyArray<{ value: string; label: string; description?: string }>
  default: string
}

/**
 * A select preference whose options are derived from runtime site state, e.g.
 * the list of breakpoints declared on the active site. The catalog declares
 * the source key; the UI / runtime resolve options at render / read time.
 *
 * `default` is the fallback value used when the source is empty or
 * unavailable (e.g. before a site is loaded).
 */
export type DynamicOptionsSource = 'site.breakpoints'

interface DynamicSelectPreferenceDef {
  id: string
  type: 'select-dynamic'
  category: PreferenceCategory
  label: string
  description: string
  optionsSource: DynamicOptionsSource
  default: string
}

type PreferenceDef =
  | BooleanPreferenceDef
  | SelectPreferenceDef
  | DynamicSelectPreferenceDef

// ---------------------------------------------------------------------------
// PREFERENCE_CATALOG — single source of truth
//
// `as const` is what makes the per-entry literal types survive into derived
// unions like `PreferenceId`. The `satisfies` clause guarantees every entry
// matches `PreferenceDef` without widening the literals.
// ---------------------------------------------------------------------------

export const PREFERENCE_CATALOG = [
  // ── Editor ──────────────────────────────────────────────────────────────
  {
    id: 'autoSave',
    type: 'boolean',
    category: 'editor',
    label: 'Auto-save',
    description: 'Automatically save the site after a period of inactivity.',
    default: true,
  },
  {
    id: 'autoSaveDelay',
    type: 'select',
    category: 'editor',
    label: 'Auto-save delay',
    description: 'How long to wait after the last edit before saving. Only applies when auto-save is on.',
    options: [
      { value: '5',   label: '5 seconds' },
      { value: '15',  label: '15 seconds' },
      { value: '30',  label: '30 seconds' },
      { value: '60',  label: '1 minute' },
      { value: '300', label: '5 minutes' },
    ],
    default: '30',
  },
  {
    id: 'hoverPreview',
    type: 'boolean',
    category: 'editor',
    label: 'Preview suggestions on hover',
    description: 'Temporarily apply class suggestions, design tokens (spacing, colour, …), and variable autocomplete entries to the selected canvas element while hovering them in the Properties panel.',
    default: true,
  },
  {
    id: 'confirmBeforeDelete',
    type: 'boolean',
    category: 'editor',
    label: 'Confirm before deleting layers',
    description: 'Ask before removing a layer via the Delete key or context menu. Off by default to match power-user flow.',
    default: false,
  },
  {
    id: 'theme',
    type: 'select',
    category: 'editor',
    label: 'Theme',
    description: 'Choose whether the admin interface uses the default dark chrome or a light theme.',
    options: [
      { value: 'dark',  label: 'Dark' },
      { value: 'light', label: 'Light' },
    ],
    default: 'dark',
  },
  {
    id: 'density',
    type: 'select',
    category: 'editor',
    label: 'UI density',
    description: 'Compact packs more on screen; comfortable gives larger touch targets and more breathing room.',
    options: [
      { value: 'compact',     label: 'Compact' },
      { value: 'comfortable', label: 'Comfortable' },
    ],
    default: 'compact',
  },
  {
    id: 'textScale',
    type: 'select',
    category: 'editor',
    label: 'UI text size',
    description: 'Scale admin interface text independently from spacing density.',
    options: [
      { value: 'small',       label: 'Small' },
      { value: 'default',     label: 'Default' },
      { value: 'large',       label: 'Large' },
      { value: 'extra-large', label: 'Extra large' },
    ],
    default: 'default',
  },

  // ── Canvas ──────────────────────────────────────────────────────────────
  {
    id: 'defaultBreakpoint',
    type: 'select-dynamic',
    category: 'canvas',
    label: 'Default viewport',
    description: 'Which viewport context the canvas focuses on when a site is opened. Mobile-first designers usually pick mobile.',
    optionsSource: 'site.breakpoints',
    default: 'desktop',
  },
  {
    id: 'dimInactiveBreakpoints',
    type: 'boolean',
    category: 'canvas',
    label: 'Dim inactive viewports when editing',
    description: 'When a layer is selected and the properties panel is open, fade non-active viewport frames to focus attention on the one being edited.',
    default: true,
  },

  // ── Layers panel ────────────────────────────────────────────────────────
  {
    id: 'layersShowIcon',
    type: 'boolean',
    category: 'layers',
    label: 'Show module icon',
    description: 'Display the module type icon (Container, Text, Image, …) at the start of each layer row.',
    default: true,
  },
  {
    id: 'layersShowTag',
    type: 'boolean',
    category: 'layers',
    label: 'Show HTML tag',
    description: 'Display a tinted pill with the underlying HTML tag (div, header, img, …) before each layer name.',
    default: true,
  },
  {
    id: 'layersShowClasses',
    type: 'boolean',
    category: 'layers',
    label: 'Show class names',
    description: 'Display assigned CSS class names after each layer name in CSS-selector form (e.g. `.header.padding-m`).',
    default: true,
  },
  {
    id: 'layersAutoExpandSelected',
    type: 'boolean',
    category: 'layers',
    label: 'Auto-expand on selection',
    description: 'Expand the ancestors of the selected layer so it stays visible in the tree.',
    default: true,
  },
  {
    id: 'layersSmoothScroll',
    type: 'boolean',
    category: 'layers',
    label: 'Smooth scroll to selected',
    description: 'Animate scrolling when the tree jumps to a newly selected layer. Turn off for instant snapping.',
    default: true,
  },

  // ── Properties panel ────────────────────────────────────────────────────
  {
    id: 'propertiesSmoothScroll',
    type: 'boolean',
    category: 'properties',
    label: 'Smooth scroll on tab change',
    description: 'Animate the properties panel when switching between Style / Module / Component tabs.',
    default: true,
  },
  {
    id: 'propertiesSectionsExpanded',
    type: 'boolean',
    category: 'properties',
    label: 'Expand style sections by default',
    description: 'Open every property section (Module, Layout, Typography, …) when an element is selected. Turn off to start with all sections collapsed.',
    default: true,
  },

  // ── Command palette (spotlight) ──────────────────────────────────────────
  {
    id: 'spotlightTelemetryEnabled',
    type: 'boolean',
    category: 'spotlight',
    label: 'Track command usage (local only)',
    description:
      'Anonymously count which commands you run most often so the palette can surface them higher. Data never leaves this device.',
    default: false,
  },
] as const satisfies ReadonlyArray<PreferenceDef>

// ---------------------------------------------------------------------------
// Derived types
//
// `as const` on the catalog preserves per-entry literal types. We export the
// element type as `CatalogPreferenceDef` so consumers iterating the catalog
// keep their narrowing — handy in the auto-rendered PreferencesSection where
// `pref.id` must stay the literal union (so it satisfies `BooleanPreferenceId`
// without a cast).
// ---------------------------------------------------------------------------

export type CatalogPreferenceDef = typeof PREFERENCE_CATALOG[number]

/** Catalog entries narrowed to boolean-typed preferences. */
export type BooleanCatalogDef = Extract<CatalogPreferenceDef, { type: 'boolean' }>

/** Catalog entries narrowed to either kind of select-typed preference. */
export type SelectCatalogDef = Extract<
  CatalogPreferenceDef,
  { type: 'select' | 'select-dynamic' }
>

/** Union of every preference id, narrowed to literal strings via `as const`. */
type PreferenceId = CatalogPreferenceDef['id']

/** Subset of ids whose value is a boolean. */
export type BooleanPreferenceId = BooleanCatalogDef['id']

/** Subset of ids whose value is a string (static or dynamic select). */
export type SelectPreferenceId = SelectCatalogDef['id']

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CATALOG_BY_ID: ReadonlyMap<PreferenceId, CatalogPreferenceDef> = new Map(
  PREFERENCE_CATALOG.map((p) => [p.id, p]),
)

function getPreferenceDef(id: PreferenceId): CatalogPreferenceDef {
  const def = CATALOG_BY_ID.get(id)
  if (!def) throw new Error(`[preferences] unknown preference id: ${id}`)
  return def
}

/** Returns the default value of a boolean preference. */
export function defaultBooleanFor(id: BooleanPreferenceId): boolean {
  const def = getPreferenceDef(id)
  if (def.type !== 'boolean') {
    throw new Error(`[preferences] expected boolean default for ${id}`)
  }
  return def.default
}

/** Returns the default value of a select / select-dynamic preference. */
export function defaultSelectFor(id: SelectPreferenceId): string {
  const def = getPreferenceDef(id)
  if (def.type !== 'select' && def.type !== 'select-dynamic') {
    throw new Error(`[preferences] expected select default for ${id}`)
  }
  return def.default
}

/**
 * Iterate the catalog grouped by category, in catalog declaration order.
 * Returns `CatalogPreferenceDef` (not `PreferenceDef`) so consumers retain
 * the literal id type — required so `useEditorPreference(pref.id)` typechecks
 * inside the auto-rendered Preferences section.
 */
export function preferencesByCategory(): ReadonlyArray<{
  id: PreferenceCategory
  label: string
  description?: string
  preferences: ReadonlyArray<CatalogPreferenceDef>
}> {
  return PREFERENCE_CATEGORIES.map((cat) => ({
    ...cat,
    preferences: PREFERENCE_CATALOG.filter((p) => p.category === cat.id),
  })).filter((group) => group.preferences.length > 0)
}
