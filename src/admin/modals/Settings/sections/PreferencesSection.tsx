/**
 * PreferencesSection — auto-renders every entry in the preference catalog,
 * grouped by category. Adding a new preference requires only a catalog edit
 * (see `admin/pages/site/preferences/catalog.ts`).
 *
 * The dispatcher in `PreferenceRow` switches on `pref.type` to pick the right
 * concrete row component. Each preference type has exactly one row component
 * — `BooleanPreferenceRow`, `SelectPreferenceRow` — and one runtime hook
 * (`useEditorPreference`, `useEditorSelectPreference`).
 *
 * Special handling for the 'spotlight' category: a "Clear command history"
 * button is appended after the catalog-derived rows.
 */
import { useEditorStore } from '@site/store/store'
import { Switch } from '@ui/components/Switch'
import { Select } from '@ui/components/Select'
import { Button } from '@ui/components/Button'
import {
  preferencesByCategory,
  type BooleanCatalogDef,
  type CatalogPreferenceDef,
  type DynamicOptionsSource,
  type SelectCatalogDef,
} from '@site/preferences/catalog'
import {
  setEditorPreference,
  setEditorSelectPreference,
  useEditorPreference,
  useEditorSelectPreference,
} from '@site/preferences/editorPreferences'
import { clearTelemetry } from '@admin/spotlight/telemetry'
import { clearRecentCommands } from '@admin/spotlight/recentStore'
import { useCurrentAdminUser } from '@admin/sessionContext'
import { canEditStructure } from '@admin/access'
import s from '../SettingsModal.module.css'

export function PreferencesSection() {
  const currentUser = useCurrentAdminUser()
  // Gated preferences are hidden, not disabled — a user who can't use the
  // feature shouldn't see a dead toggle. Gate checks live in access.ts.
  const passesGate = (pref: CatalogPreferenceDef): boolean =>
    !('gate' in pref) || pref.gate !== 'structure-edit' || canEditStructure(currentUser)
  const groups = preferencesByCategory()
    .map((group) => ({
      ...group,
      preferences: group.preferences.filter(passesGate),
    }))
    .filter((group) => group.preferences.length > 0)

  return (
    <div>
      <p className={s.sectionDescription}>
        Editor preferences are stored locally on this device and do not affect the site file.
      </p>

      {groups.map((group) => (
        <section key={group.id} className={s.sectionBlock}>
          <h4 className={s.subHeading}>{group.label}</h4>
          {group.description && (
            <p className={s.preferenceCategoryDesc}>{group.description}</p>
          )}
          <div className={s.cardGroup}>
            {group.preferences.map((pref) => (
              <PreferenceRow key={pref.id} pref={pref} />
            ))}
            {group.id === 'spotlight' && (
              <SpotlightHistoryControls />
            )}
          </div>
        </section>
      ))}
    </div>
  )
}

// ─── Helper: PreferenceRow ────────────────────────────────────────────────────

function PreferenceRow({ pref }: { pref: CatalogPreferenceDef }) {
  if (pref.type === 'boolean') return <BooleanPreferenceRow pref={pref} />
  if (pref.type === 'select') return <SelectPreferenceRow pref={pref} />
  if (pref.type === 'select-dynamic') return <DynamicSelectPreferenceRow pref={pref} />
  return null
}

function BooleanPreferenceRow({ pref }: { pref: BooleanCatalogDef }) {
  const checked = useEditorPreference(pref.id)
  const id = `pref-${pref.id}`

  return (
    <div className={s.toggleRow}>
      <div className={s.toggleRowContent}>
        <label htmlFor={id} className={s.toggleRowLabel}>
          {pref.label}
        </label>
        <p className={s.toggleRowDesc}>{pref.description}</p>
      </div>
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={(value) => setEditorPreference(pref.id, value)}
      />
    </div>
  )
}

function SelectPreferenceRow({
  pref,
}: { pref: Extract<SelectCatalogDef, { type: 'select' }> }) {
  const value = useEditorSelectPreference(pref.id)
  const id = `pref-${pref.id}`

  return (
    <div className={s.toggleRow}>
      <div className={s.toggleRowContent}>
        <label htmlFor={id} className={s.toggleRowLabel}>
          {pref.label}
        </label>
        <p className={s.toggleRowDesc}>{pref.description}</p>
      </div>
      <Select
        id={id}
        fieldSize="sm"
        value={value}
        options={pref.options.map((option) => ({
          value: option.value,
          label: option.label,
        }))}
        onChange={(event) => setEditorSelectPreference(pref.id, event.target.value)}
        aria-label={pref.label}
        className={s.preferenceSelect}
      />
    </div>
  )
}

/**
 * Resolves dynamic select options at render time. Each `optionsSource` enum
 * value maps to a hook that returns the live option list. Adding a new source
 * is one new branch here + one constant in `catalog.ts`.
 *
 * Each branch is its own hook so React's rules-of-hooks stay satisfied — we
 * pick which one to call before any hooks run. Inline `?? []` after
 * `useEditorStore` is forbidden by Guideline #239 (creates a new array
 * identity per render and destabilises downstream selectors), so the
 * breakpoints branch returns directly from a selector that maps inside the
 * Zustand selector itself, with a stable empty fallback.
 */
const EMPTY_OPTIONS: ReadonlyArray<{ value: string; label: string }> = []

function useDynamicSelectOptions(
  source: DynamicOptionsSource,
): ReadonlyArray<{ value: string; label: string }> {
  const breakpointsOptions = useEditorStore((state) => state.site?.breakpoints)
  if (source === 'site.breakpoints') {
    if (!breakpointsOptions) return EMPTY_OPTIONS
    return breakpointsOptions.map((bp) => ({ value: bp.id, label: bp.label }))
  }
  return EMPTY_OPTIONS
}

// ─── Spotlight history controls ───────────────────────────────────────────────

/**
 * "Clear command history" button rendered inside the spotlight preference group.
 * Clears both the recent-command list (recentStore) and opt-in telemetry data.
 * Lives here (not in the catalog) because it is an action, not a stored value.
 */
function SpotlightHistoryControls() {
  return (
    <div className={s.toggleRow}>
      <div className={s.toggleRowContent}>
        <span className={s.toggleRowLabel}>Clear command history</span>
        <p className={s.toggleRowDesc}>
          Removes the list of recently run commands shown when the palette opens
          with an empty query, and erases any local usage counts.
        </p>
      </div>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => {
          clearRecentCommands()
          clearTelemetry()
        }}
      >
        Clear
      </Button>
    </div>
  )
}

function DynamicSelectPreferenceRow({
  pref,
}: { pref: Extract<SelectCatalogDef, { type: 'select-dynamic' }> }) {
  const value = useEditorSelectPreference(pref.id)
  const dynamicOptions = useDynamicSelectOptions(pref.optionsSource)
  const id = `pref-${pref.id}`

  // Always show the stored value as a selectable option, even when the
  // current site no longer declares that id. This way the user sees what is
  // actually persisted instead of having the dropdown silently snap to the
  // first option on every render. The fallback label is the raw id so the
  // mismatch is obvious.
  const valueIsKnown = dynamicOptions.some((option) => option.value === value)
  const options = valueIsKnown
    ? dynamicOptions
    : [{ value, label: `${value} (not in current site)` }, ...dynamicOptions]

  // Empty state: site not loaded yet, or it has no items in the source.
  // Render a disabled select with a single placeholder to keep the row
  // shape stable. Copy into a mutable array for the Select primitive's API.
  const isEmpty = options.length === 0
  const renderOptions = isEmpty
    ? [{ value: pref.default, label: 'No options available' }]
    : [...options]

  return (
    <div className={s.toggleRow}>
      <div className={s.toggleRowContent}>
        <label htmlFor={id} className={s.toggleRowLabel}>
          {pref.label}
        </label>
        <p className={s.toggleRowDesc}>{pref.description}</p>
      </div>
      <Select
        id={id}
        fieldSize="sm"
        value={value}
        options={renderOptions}
        onChange={(event) => setEditorSelectPreference(pref.id, event.target.value)}
        disabled={isEmpty}
        aria-label={pref.label}
        className={s.preferenceSelect}
      />
    </div>
  )
}
