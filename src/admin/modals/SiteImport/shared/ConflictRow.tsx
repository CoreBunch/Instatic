/**
 * ConflictRow — a single slug, class-name, or design-token conflict with its
 * resolution picker.
 *
 * Shows the source path (or class / token name) and a segmented control for the
 * resolution action. When "Custom…" is selected, an `<Input>` appears inline
 * for the user to type the custom slug / class / token variable.
 */
import { SegmentedControl } from '@ui/components/SegmentedControl'
import { Input } from '@ui/components/Input'
import type { ConflictResolution } from '@core/siteImport'
import styles from './ConflictRow.module.css'

type ResolutionAction = ConflictResolution['action']

type ConflictRowKind = 'page' | 'rule' | 'token'

const ACTION_OPTIONS = [
  { value: 'auto-rename', label: 'Rename', tooltip: 'Rename with a numeric suffix' },
  { value: 'skip',        label: 'Skip' },
  { value: 'overwrite',   label: 'Overwrite' },
  { value: 'custom-rename', label: 'Custom' },
] satisfies ReadonlyArray<{ value: ResolutionAction; label: string; tooltip?: string }>

// Options minus "Overwrite" — used when there is no existing target to
// overwrite (an intra-batch collision between two imported items).
const ACTION_OPTIONS_NO_OVERWRITE = ACTION_OPTIONS.filter((o) => o.value !== 'overwrite')

/** Read the resolved value for the active kind out of a resolution. */
function resolvedValue(kind: ConflictRowKind, res: ConflictResolution): string | undefined {
  if (kind === 'page') return res.resolvedSlug
  if (kind === 'rule') return res.resolvedName
  return res.resolvedVariable
}

/** Build a custom-rename resolution carrying the value on the right field. */
function customResolution(kind: ConflictRowKind, value: string): ConflictResolution {
  if (kind === 'page') return { action: 'custom-rename', resolvedSlug: value }
  if (kind === 'rule') return { action: 'custom-rename', resolvedName: value }
  return { action: 'custom-rename', resolvedVariable: value }
}

const CUSTOM_PLACEHOLDER: Record<ConflictRowKind, string> = {
  page: 'custom-slug',
  rule: 'custom-class',
  token: 'custom-token',
}

const CUSTOM_LABEL: Record<ConflictRowKind, string> = {
  page: 'Custom slug',
  rule: 'Custom class name',
  token: 'Custom token variable',
}

interface ConflictRowProps {
  kind: ConflictRowKind
  source: string
  desired: string
  current: ConflictResolution
  /**
   * Whether an "Overwrite" target actually exists. False for intra-batch
   * collisions (two imported items resolving to the same slug/name with no
   * pre-existing page/rule) — overwriting nothing is meaningless and would
   * abort the commit, so the option is hidden.
   */
  canOverwrite?: boolean
  onChange: (next: ConflictResolution) => void
}

export function ConflictRow({ kind, source, desired, current, canOverwrite = true, onChange }: ConflictRowProps) {
  const isCustom = current.action === 'custom-rename'
  const resolutionLabel = kind === 'page' ? (source || desired) : desired
  const customValue = resolvedValue(kind, current) ?? desired

  function handleActionChange(action: ResolutionAction) {
    // custom-rename pre-fills with the desired value; the rest carry no payload.
    onChange(action === 'custom-rename' ? customResolution(kind, desired) : { action })
  }

  return (
    <div className={styles.row}>
      <div className={styles.meta}>
        <span className={styles.source}>{source || desired}</span>
        <span className={styles.desired}>{desired}</span>
      </div>
      <div className={styles.controls}>
        <SegmentedControl<ResolutionAction>
          value={current.action}
          options={canOverwrite ? ACTION_OPTIONS : ACTION_OPTIONS_NO_OVERWRITE}
          onChange={handleActionChange}
          size="xs"
          aria-label={`Conflict resolution for ${resolutionLabel}`}
        />
        {isCustom && (
          <Input
            fieldSize="sm"
            value={customValue}
            onChange={(e) => onChange(customResolution(kind, e.target.value))}
            placeholder={CUSTOM_PLACEHOLDER[kind]}
            aria-label={CUSTOM_LABEL[kind]}
          />
        )}
      </div>
    </div>
  )
}
