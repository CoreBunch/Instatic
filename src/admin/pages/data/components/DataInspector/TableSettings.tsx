import { useState, type ReactElement } from 'react'
import { Button } from '@ui/components/Button'
import { Input } from '@ui/components/Input'
import { Select } from '@ui/components/Select'
import { Section } from '@ui/components/Section'
import { ControlRow } from '@ui/components/ControlRow'
import sectionStyles from '@ui/components/Section/Section.module.css'
import { Settings2SolidIcon } from 'pixel-art-icons/icons/settings-2-solid'
import { LinkIcon } from 'pixel-art-icons/icons/link'
import { EyeSolidIcon } from 'pixel-art-icons/icons/eye-solid'
import { ListBoxSolidIcon } from 'pixel-art-icons/icons/list-box-solid'
import { BoxSolidIcon } from 'pixel-art-icons/icons/box-solid'
import { TrashSolidIcon } from 'pixel-art-icons/icons/trash-solid'
import { useConfirmDelete } from '@admin/shared/dialogs/ConfirmDeleteDialog'
import { StepUpCancelledMessage } from '@admin/shared/StepUp'
import type { DataTable, DataRow, UpdateDataTableInput } from '@core/data/schemas'
import { FieldsSection } from './FieldsSection'
import styles from './DataInspector.module.css'
import { getErrorMessage } from '@core/utils/errorMessage'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TableSettingsProps {
  table: DataTable
  /** All tables — needed by FieldsSection for relation-target resolution. */
  tables: DataTable[]
  /** Current rows — used for the field-delete row-count warning. */
  rows: DataRow[]
  onUpdateTable: (input: UpdateDataTableInput) => Promise<DataTable>
  onDeleteTable: () => Promise<void>
  canEdit: boolean
  canDelete: boolean
}

interface SettingsDraft {
  name: string
  slug: string
  singularLabel: string
  pluralLabel: string
  routeBase: string
  primaryFieldId: string
}

function isStepUpCancelled(err: unknown): boolean {
  return err instanceof Error && err.message === StepUpCancelledMessage
}

// ---------------------------------------------------------------------------
// Module-level helpers — extracted so the React Compiler can auto-memoize the
// TableSettings component body (try/catch in async causes compiler bailout
// when nested inside a component function).
// ---------------------------------------------------------------------------

async function saveTableField(
  key: keyof SettingsDraft,
  value: string,
  table: DataTable,
  onUpdateTable: (input: UpdateDataTableInput) => Promise<DataTable>,
  setSaving: (v: boolean) => void,
  setSaveError: (v: string | null) => void,
  setDraft: (updater: (prev: SettingsDraft) => SettingsDraft) => void,
): Promise<void> {
  setSaving(true)
  setSaveError(null)
  try {
    await onUpdateTable({ [key]: value })
  } catch (err) {
    if (!isStepUpCancelled(err)) {
      console.error('[TableSettings] Save failed:', err)
      setSaveError(getErrorMessage(err, 'Could not save'))
    }
    // Revert the draft field to the last known-good value from the table.
    setDraft((prev) => ({
      ...prev,
      [key]: table[key as keyof DataTable] as string,
    }))
  } finally {
    setSaving(false)
  }
}

async function savePrimaryField(
  fieldId: string,
  table: DataTable,
  onUpdateTable: (input: UpdateDataTableInput) => Promise<DataTable>,
  setSaving: (v: boolean) => void,
  setSaveError: (v: string | null) => void,
  setDraft: (updater: (prev: SettingsDraft) => SettingsDraft) => void,
): Promise<void> {
  setSaving(true)
  setSaveError(null)
  try {
    await onUpdateTable({ primaryFieldId: fieldId })
  } catch (err) {
    if (!isStepUpCancelled(err)) {
      console.error('[TableSettings] Primary field save failed:', err)
      setSaveError(getErrorMessage(err, 'Could not save'))
    }
    setDraft((prev) => ({ ...prev, primaryFieldId: table.primaryFieldId }))
  } finally {
    setSaving(false)
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tableToDraft(table: DataTable): SettingsDraft {
  return {
    name: table.name,
    slug: table.slug,
    singularLabel: table.singularLabel,
    pluralLabel: table.pluralLabel,
    routeBase: table.routeBase,
    primaryFieldId: table.primaryFieldId,
  }
}

const KIND_LABELS: Record<DataTable['kind'], string> = {
  postType: 'Post type',
  data: 'Data table',
  page: 'Page',
  component: 'Component',
  layout: 'Layout',
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TableSettings({
  table,
  tables,
  rows,
  onUpdateTable,
  onDeleteTable,
  canEdit,
  canDelete,
}: TableSettingsProps): ReactElement {
  const confirmDelete = useConfirmDelete()

  const [draft, setDraft] = useState<SettingsDraft>(() => tableToDraft(table))
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // Reset draft when the table identity changes (different table selected).
  // Using render-time state update to avoid useEffect setState lint issues.
  const [trackedTableId, setTrackedTableId] = useState(table.id)
  if (trackedTableId !== table.id) {
    setTrackedTableId(table.id)
    setDraft(tableToDraft(table))
    setSaveError(null)
  }

  function patchDraft(key: keyof SettingsDraft, value: string) {
    setDraft((prev) => ({ ...prev, [key]: value }))
  }

  async function handleBlurField(key: keyof SettingsDraft) {
    if (!canEdit) return
    const value = draft[key]
    // The table prop reflects last-saved state — skip if unchanged.
    if (value === (table[key as keyof DataTable] as string)) return
    await saveTableField(key, value, table, onUpdateTable, setSaving, setSaveError, setDraft)
  }

  async function handlePrimaryFieldChange(fieldId: string) {
    if (!canEdit) return
    if (fieldId === table.primaryFieldId) return
    patchDraft('primaryFieldId', fieldId)
    await savePrimaryField(fieldId, table, onUpdateTable, setSaving, setSaveError, setDraft)
  }

  function requestDeleteTable() {
    const rowDescription = rows.length > 0
      ? `This will permanently delete ${rows.length} row${rows.length === 1 ? '' : 's'} and cannot be undone.`
      : 'This cannot be undone.'
    confirmDelete({
      title: `Delete table "${table.name}"?`,
      description: rowDescription,
      confirmLabel: 'Delete table',
      commit: () => {
        onDeleteTable().catch((err) => {
          if (isStepUpCancelled(err)) return
          console.error('[TableSettings] Delete table failed:', err)
        })
      },
    })
  }

  const primaryFieldOptions = table.fields.map((f) => ({
    value: f.id,
    label: f.label,
  }))

  return (
    <>
      {/* ── Save status banner (above all sections) ── */}
      {saveError && (
        <div className={styles.statusBanner}>
          <p role="alert" className={styles.errorBanner}>{saveError}</p>
        </div>
      )}
      {saving && (
        <div className={styles.statusBanner}>
          <p className={styles.savingText} aria-live="polite">Saving…</p>
        </div>
      )}

      {/* ── General ── */}
      <Section title="General" icon={Settings2SolidIcon} defaultOpen>
        <div className={sectionStyles.sectionBody}>
          <ControlRow propKey="name" label="Name">
            <Input
              id="ctrl-name"
              fieldSize="sm"
              value={draft.name}
              disabled={!canEdit}
              onChange={(e) => patchDraft('name', e.target.value)}
              onBlur={() => void handleBlurField('name')}
              autoComplete="off"
            />
          </ControlRow>

          <ControlRow
            propKey="slug"
            label="Slug"
            description="Changing the slug will break existing links."
          >
            <Input
              id="ctrl-slug"
              fieldSize="sm"
              value={draft.slug}
              disabled={!canEdit}
              onChange={(e) => patchDraft('slug', e.target.value)}
              onBlur={() => void handleBlurField('slug')}
              autoComplete="off"
              monospace
            />
          </ControlRow>

          <ControlRow propKey="singularLabel" label="Singular label">
            <Input
              id="ctrl-singularLabel"
              fieldSize="sm"
              value={draft.singularLabel}
              disabled={!canEdit}
              onChange={(e) => patchDraft('singularLabel', e.target.value)}
              onBlur={() => void handleBlurField('singularLabel')}
              autoComplete="off"
            />
          </ControlRow>

          <ControlRow propKey="pluralLabel" label="Plural label">
            <Input
              id="ctrl-pluralLabel"
              fieldSize="sm"
              value={draft.pluralLabel}
              disabled={!canEdit}
              onChange={(e) => patchDraft('pluralLabel', e.target.value)}
              onBlur={() => void handleBlurField('pluralLabel')}
              autoComplete="off"
            />
          </ControlRow>
        </div>
      </Section>

      {/* ── Routing ──
        Available for both `postType` and `data` kinds. Tables with a
        non-empty `routeBase` serve each published row at
        `/<routeBase>/<slug>` (rendered via the template system, or via the
        fallback data-row document when no template is configured). `data`
        kinds default to an empty `routeBase` (not routable). */}
      <Section title="Routing" icon={LinkIcon}>
        <div className={sectionStyles.sectionBody}>
          <ControlRow
            propKey="routeBase"
            label="Route base"
            description="Public URL prefix for entries. Empty = not publicly routable."
          >
            <Input
              id="ctrl-routeBase"
              fieldSize="sm"
              value={draft.routeBase}
              disabled={!canEdit}
              onChange={(e) => patchDraft('routeBase', e.target.value)}
              onBlur={() => void handleBlurField('routeBase')}
              autoComplete="off"
              monospace
              placeholder={table.kind === 'postType' ? '/posts' : `/${draft.slug || 'items'}`}
            />
          </ControlRow>
        </div>
      </Section>

      {/* ── Display ── */}
      <Section title="Display" icon={EyeSolidIcon} defaultOpen>
        <div className={sectionStyles.sectionBody}>
          <ControlRow
            propKey="primaryFieldId"
            label="Primary field"
            description="Used as the row display name in grids and relation pickers."
          >
            <Select
              id="ctrl-primaryFieldId"
              fieldSize="sm"
              value={draft.primaryFieldId}
              options={primaryFieldOptions}
              disabled={!canEdit || primaryFieldOptions.length === 0}
              onChange={(e) => void handlePrimaryFieldChange(e.target.value)}
            />
          </ControlRow>
        </div>
      </Section>

      {/* ── Fields ── */}
      <Section title="Fields" icon={ListBoxSolidIcon}>
        <FieldsSection
          table={table}
          tables={tables}
          rowCount={rows.length}
          onUpdateTable={onUpdateTable}
          canEdit={canEdit}
        />
      </Section>

      {/* ── Kind (read-only) ── */}
      <Section title="Kind" icon={BoxSolidIcon}>
        <div className={styles.kindRow}>
          <span className={styles.kindBadge}>{KIND_LABELS[table.kind]}</span>
          <span className={styles.kindCaption}>Table kind cannot be changed after creation.</span>
        </div>
      </Section>

      {/* ── Danger zone ── */}
      {canDelete && (
        <Section title="Danger zone" icon={TrashSolidIcon}>
          <div className={styles.dangerZoneBody}>
            <Button
              variant="destructive"
              size="sm"
              type="button"
              onClick={requestDeleteTable}
            >
              Delete table
            </Button>
          </div>
        </Section>
      )}
    </>
  )
}
