/**
 * ConflictRow — a single slug, class-name, design-token, site-file or media
 * conflict with its resolution picker.
 *
 * Shows the source path (or class / token name) and a segmented control for the
 * resolution action. For the renamable kinds, "Custom…" shows an `<Input>`
 * inline for the custom slug / class / token variable. Files and media are
 * reused, replaced or imported again; they have no custom name.
 */
import { SegmentedControl } from '@ui/components/SegmentedControl'
import { Input } from '@ui/components/Input'
import type { ConflictResolution } from '@core/siteImport'
import styles from './ConflictRow.module.css'

type ResolutionAction = ConflictResolution['action']

type RenamableKind = 'page' | 'rule' | 'token'
type ConflictRowKind = RenamableKind | 'file' | 'media'

type ActionOption = { value: ResolutionAction; label: string; tooltip?: string }

const ACTION_OPTIONS = [
  { value: 'auto-rename', label: 'Rename', tooltip: 'Rename with a numeric suffix' },
  { value: 'skip',        label: 'Skip' },
  { value: 'overwrite',   label: 'Overwrite' },
  { value: 'custom-rename', label: 'Custom' },
] satisfies ReadonlyArray<ActionOption>

// Options minus "Overwrite" — used when there is no existing target to
// overwrite (an intra-batch collision between two imported items).
const ACTION_OPTIONS_NO_OVERWRITE = ACTION_OPTIONS.filter((o) => o.value !== 'overwrite')

const FILE_OPTIONS: ActionOption[] = [
  { value: 'skip', label: 'Use existing', tooltip: 'Keep the file already in this site' },
  { value: 'overwrite', label: 'Replace', tooltip: 'Replace its content with the imported file' },
  { value: 'auto-rename', label: 'Keep both', tooltip: 'Import a second copy with a numeric suffix' },
]

const MEDIA_OPTIONS: ActionOption[] = [
  { value: 'skip', label: 'Use existing', tooltip: 'Point the import at the file already in the library' },
  { value: 'auto-rename', label: 'Upload a copy' },
]

function optionsFor(kind: ConflictRowKind, canOverwrite: boolean): ActionOption[] {
  if (kind === 'file') return FILE_OPTIONS
  if (kind === 'media') return MEDIA_OPTIONS
  return canOverwrite ? ACTION_OPTIONS : ACTION_OPTIONS_NO_OVERWRITE
}

function isRenamable(kind: ConflictRowKind): kind is RenamableKind {
  return kind === 'page' || kind === 'rule' || kind === 'token'
}

/** Read the resolved value for the active kind out of a resolution. */
function resolvedValue(kind: RenamableKind, res: ConflictResolution): string | undefined {
  if (kind === 'page') return res.resolvedSlug
  if (kind === 'rule') return res.resolvedName
  return res.resolvedVariable
}

/** Build a custom-rename resolution carrying the value on the right field. */
function customResolution(kind: RenamableKind, value: string): ConflictResolution {
  if (kind === 'page') return { action: 'custom-rename', resolvedSlug: value }
  if (kind === 'rule') return { action: 'custom-rename', resolvedName: value }
  return { action: 'custom-rename', resolvedVariable: value }
}

const CUSTOM_PLACEHOLDER: Record<RenamableKind, string> = {
  page: 'custom-slug',
  rule: 'custom-class',
  token: 'custom-token',
}

const CUSTOM_LABEL: Record<RenamableKind, string> = {
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
  /** Field-local problem with the rename target, shown under the controls. */
  error?: string
  onChange: (next: ConflictResolution) => void
}

export function ConflictRow({ kind, source, desired, current, canOverwrite = true, error, onChange }: ConflictRowProps) {
  const renamable = isRenamable(kind) ? kind : null
  const isCustom = renamable !== null && current.action === 'custom-rename'
  const resolutionLabel = kind === 'page' ? (source || desired) : desired

  function handleActionChange(action: ResolutionAction) {
    // custom-rename pre-fills with the desired value; the rest carry no payload.
    onChange(action === 'custom-rename' && renamable ? customResolution(renamable, desired) : { action })
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
          options={optionsFor(kind, canOverwrite)}
          onChange={handleActionChange}
          size="xs"
          aria-label={`Conflict resolution for ${resolutionLabel}`}
        />
        {isCustom && renamable && (
          <Input
            fieldSize="sm"
            value={resolvedValue(renamable, current) ?? desired}
            onChange={(e) => onChange(customResolution(renamable, e.target.value))}
            placeholder={CUSTOM_PLACEHOLDER[renamable]}
            aria-label={CUSTOM_LABEL[renamable]}
            aria-invalid={error ? true : undefined}
          />
        )}
        {error && <p role="alert" className={styles.error}>{error}</p>}
      </div>
    </div>
  )
}
