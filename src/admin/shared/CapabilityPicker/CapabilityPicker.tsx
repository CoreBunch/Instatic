/**
 * CapabilityPicker — the shared capability checklist used by the role-edit
 * dialog and the MCP connector dialog.
 *
 * Presentational + selection-math only. The caller supplies the `groups` to
 * render (the full role grouping, or a curated MCP subset) and the current
 * `selected` set; the picker emits the next set via `onChange`. Group/master
 * "Select all / Clear" operate only on the picker's own capabilities and
 * preserve any selected capability outside the rendered groups.
 *
 * Labels + descriptions come from the co-located `CAPABILITY_META`, so both
 * dialogs render identical wording. Styling lives in `CapabilityPicker.module.css`.
 */
import { Button } from '@ui/components/Button'
import { Checkbox } from '@ui/components/Checkbox'
import type { CoreCapability } from '@core/capabilities'
import { CAPABILITY_META, capabilityLabel } from './capabilityMeta'
import styles from './CapabilityPicker.module.css'

export interface CapabilityPickerGroup {
  title: string
  capabilities: readonly CoreCapability[]
}

interface CapabilityPickerProps {
  /** The groups to render, in order. Each becomes a card with its own toggle. */
  groups: readonly CapabilityPickerGroup[]
  /** Currently-selected capabilities. */
  selected: ReadonlySet<CoreCapability>
  /** Emits the next selection. Not called in `readonly` mode. */
  onChange: (next: Set<CoreCapability>) => void
  /** Read-only: every checkbox disabled, all toggles hidden. */
  readonly?: boolean
  /** Capabilities shown for context but unavailable for selection. */
  disabledCapabilities?: ReadonlySet<CoreCapability>
  /** Picker heading. Defaults to "Capabilities". */
  title?: string
}

export function CapabilityPicker({
  groups,
  selected,
  onChange,
  readonly = false,
  disabledCapabilities = new Set(),
  title = 'Capabilities',
}: CapabilityPickerProps) {
  // De-duplicate across groups for the master count/toggle (groups are normally
  // disjoint, but don't assume it).
  const renderedCaps = [...new Set(groups.flatMap((g) => g.capabilities))]
  const selectableCaps = readonly
    ? renderedCaps
    : renderedCaps.filter((capability) => !disabledCapabilities.has(capability))
  const totalCount = selectableCaps.length
  const selectedCount = selectableCaps.reduce((n, cap) => (selected.has(cap) ? n + 1 : n), 0)
  const allSelected = totalCount > 0 && selectedCount === totalCount

  function setMany(capabilities: readonly CoreCapability[], checked: boolean) {
    const next = new Set(selected)
    for (const cap of capabilities) {
      if (disabledCapabilities.has(cap)) continue
      if (checked) next.add(cap)
      else next.delete(cap)
    }
    onChange(next)
  }

  return (
    <section className={styles.capabilityPicker} aria-label={title}>
      <header className={styles.capabilityPickerHeader}>
        <div className={styles.capabilityPickerSummary}>
          <h3 className={styles.capabilityPickerTitle}>{title}</h3>
          <p className={styles.capabilityPickerCount}>
            <strong>{selectedCount}</strong> of {totalCount} selected
          </p>
        </div>
        {!readonly && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-label={allSelected ? 'Clear all capabilities' : 'Select all capabilities'}
            onClick={() => setMany(selectableCaps, !allSelected)}
          >
            <span>{allSelected ? 'Clear all' : 'Select all'}</span>
          </Button>
        )}
      </header>

      <div className={styles.capabilityGroups}>
        {groups.map((group) => {
          const selectableGroupCapabilities = readonly
            ? group.capabilities
            : group.capabilities.filter((capability) => !disabledCapabilities.has(capability))
          const groupSelected = selectableGroupCapabilities.filter((cap) => selected.has(cap)).length
          const groupTotal = selectableGroupCapabilities.length
          const groupAllSelected = groupTotal > 0 && groupSelected === groupTotal
          return (
            <section key={group.title} className={styles.capabilityGroup}>
              <header className={styles.capabilityGroupHeader}>
                <div className={styles.capabilityGroupHeading}>
                  <h4>{group.title}</h4>
                  <span
                    className={styles.capabilityGroupCount}
                    data-state={groupAllSelected ? 'full' : groupSelected > 0 ? 'partial' : 'empty'}
                  >
                    {groupSelected}/{groupTotal}
                  </span>
                </div>
                {!readonly && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    aria-label={
                      groupAllSelected
                        ? `Clear ${group.title} capabilities`
                        : `Select all ${group.title} capabilities`
                    }
                    onClick={() => setMany(selectableGroupCapabilities, !groupAllSelected)}
                  >
                    <span>{groupAllSelected ? 'Clear' : 'Select all'}</span>
                  </Button>
                )}
              </header>
              <ul className={styles.capabilityList}>
                {group.capabilities.map((capability) => {
                  const meta = CAPABILITY_META[capability]
                  const checked = selected.has(capability)
                  const disabled = readonly || disabledCapabilities.has(capability)
                  return (
                    <li key={capability} className={styles.capabilityItem} data-checked={checked}>
                      <label className={styles.capabilityRow}>
                        <Checkbox
                          checked={checked}
                          disabled={disabled}
                          onCheckedChange={(next) => setMany([capability], next)}
                        />
                        <span className={styles.capabilityRowText}>
                          <span className={styles.capabilityRowLabel}>
                            {meta?.label ?? capabilityLabel(capability)}
                          </span>
                          {meta && (
                            <span className={styles.capabilityRowDescription}>{meta.description}</span>
                          )}
                        </span>
                      </label>
                    </li>
                  )
                })}
              </ul>
            </section>
          )
        })}
      </div>
    </section>
  )
}
