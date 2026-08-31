import { useId, useRef, useState, type FormEvent } from 'react'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import { Input } from '@ui/components/Input'
import { SegmentedControl } from '@ui/components/SegmentedControl'
import { pushToast } from '@ui/components/Toast'
import { buildPostTypeDefaultFields, isPrimaryFieldCandidate } from '@core/data/fields'
import {
  type CreateDataTableInput,
  type DataField,
  type DataTable,
  type DataTableKind,
} from '@core/data/schemas'
import { StepUpCancelledMessage } from '@admin/shared/StepUp'
import { FieldSchemaComposer } from '../FieldSchemaComposer'
import styles from './NewTableDialog.module.css'
import { getErrorMessage } from '@core/utils/errorMessage'
import { slugify } from '@admin/lib/slugify'

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function singularFromPlural(value: string): string {
  if (/[^aeiou]ies$/i.test(value)) return value.replace(/ies$/i, 'y')
  if (/(?:s|x|z|ch|sh)es$/i.test(value)) return value.replace(/es$/i, '')
  if (/ss$/i.test(value)) return value
  return value.replace(/s$/i, '') || value
}

function errorMessage(err: unknown, noun: 'table' | 'collection'): string {
  return getErrorMessage(err, `Could not create ${noun}`).replace(/^\[[^\]]+\]\s*/, '')
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface NewTableDialogProps {
  open: boolean
  onClose: () => void
  onCreate: (input: CreateDataTableInput) => Promise<void>
  tables: DataTable[]
  variant?: 'table' | 'collection'
}

const KIND_OPTIONS: ReadonlyArray<{ value: DataTableKind; label: string }> = [
  { value: 'data', label: 'Data table' },
  { value: 'postType', label: 'Post type' },
]

const KIND_DESCRIPTIONS: Record<DataTableKind, string> = {
  data: 'A grid of structured records — products, FAQs, team members, etc.',
  postType: 'Authored content with title, body, slug, and publish workflow.',
  page: 'System table for page content (managed internally).',
  component: 'System table for visual component definitions (managed internally).',
  layout: 'System table for saved layout snapshots (managed internally).',
}

const FORM_ID = 'new-table-dialog-form'
const SLUG_PLACEHOLDER = 'projects'

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function NewTableDialog({
  open,
  onClose,
  onCreate,
  tables,
  variant = 'table',
}: NewTableDialogProps) {
  const isCollection = variant === 'collection'
  const initialKind: DataTableKind = isCollection ? 'postType' : 'data'
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugTouched, setSlugTouched] = useState(false)
  const [kind, setKind] = useState<DataTableKind>(initialKind)
  const [singularLabel, setSingularLabel] = useState('')
  const [singularTouched, setSingularTouched] = useState(false)
  const [pluralLabel, setPluralLabel] = useState('')
  const [pluralTouched, setPluralTouched] = useState(false)
  const [fieldsByKind, setFieldsByKind] = useState<Record<'data' | 'postType', DataField[]>>({
    data: [{ type: 'text', id: 'name', label: 'Name', required: true }],
    postType: buildPostTypeDefaultFields(),
  })
  const [primaryFieldsByKind, setPrimaryFieldsByKind] = useState<Record<'data' | 'postType', string>>({
    data: 'name',
    postType: 'title',
  })
  const [saving, setSaving] = useState(false)

  const inputRef = useRef<HTMLInputElement>(null)
  const nameId = useId()
  const slugId = useId()
  const singularId = useId()
  const pluralId = useId()

  // Derived values
  const trimmedName = name.trim()
  const generatedSlug = trimmedName ? slugify(trimmedName) : ''
  const displayedSlug = slugTouched ? slug : generatedSlug
  const effectiveSlug = kind === 'postType'
    ? slugify(displayedSlug || trimmedName)
    : generatedSlug

  const displayedPlural = pluralTouched ? pluralLabel : trimmedName
  const displayedSingular = singularTouched
    ? singularLabel
    : singularFromPlural(displayedPlural.trim())
  const editableKind = kind === 'postType' ? 'postType' : 'data'
  const fields = fieldsByKind[editableKind]
  const primaryFieldId = primaryFieldsByKind[editableKind]

  const canCreate = Boolean(trimmedName && effectiveSlug && fields.length > 0 && primaryFieldId && !saving)

  function resetForm() {
    setName('')
    setSlug('')
    setSlugTouched(false)
    setKind(initialKind)
    setSingularLabel('')
    setSingularTouched(false)
    setPluralLabel('')
    setPluralTouched(false)
    setFieldsByKind({
      data: [{ type: 'text', id: 'name', label: 'Name', required: true }],
      postType: buildPostTypeDefaultFields(),
    })
    setPrimaryFieldsByKind({ data: 'name', postType: 'title' })
    setSaving(false)
  }

  function handleClose() {
    resetForm()
    onClose()
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (!canCreate) return

    const routeBase = kind === 'postType' ? `/${effectiveSlug}` : ''

    const input: CreateDataTableInput = {
      name: trimmedName,
      slug: effectiveSlug,
      kind,
      routeBase,
      singularLabel: displayedSingular.trim() || trimmedName,
      pluralLabel: displayedPlural.trim() || trimmedName,
      primaryFieldId,
      fields,
    }

    setSaving(true)
    try {
      await onCreate(input)
      resetForm()
    } catch (err) {
      if (err instanceof Error && err.message === StepUpCancelledMessage) {
        setSaving(false)
        return
      }
      const noun = isCollection ? 'collection' : 'table'
      const message = errorMessage(err, noun)
      console.error(`[NewTableDialog] ${isCollection ? 'Collection' : 'Table'} creation failed:`, err)
      pushToast({
        kind: 'error',
        title: isCollection ? 'Collection creation failed' : 'Table creation failed',
        body: message,
        location: isCollection ? 'content-workspace' : 'data-workspace',
      })
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title={isCollection ? 'New collection' : 'New table'}
      eyebrow="Data model"
      size="2xl"
      initialFocusRef={inputRef}
      className={styles.dialog}
      bodyClassName={styles.dialogBody}
      footer={
        <>
          <Button variant="ghost" size="sm" type="button" onClick={handleClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            type="submit"
            form={FORM_ID}
            disabled={!canCreate}
          >
            {saving ? 'Creating…' : 'Create'}
          </Button>
        </>
      }
    >
      <form id={FORM_ID} className={styles.form} onSubmit={handleSubmit}>
        <div className={styles.setupPane}>
          <div className={styles.setupSections}>
            <section className={styles.setupSection}>
              {!isCollection && (
                <div className={styles.kindPicker}>
                  <SegmentedControl
                    value={kind}
                    options={KIND_OPTIONS}
                    onChange={setKind}
                    fullWidth
                    aria-label="Table kind"
                  />
                  <span className={styles.caption}>{KIND_DESCRIPTIONS[kind]}</span>
                </div>
              )}

              <div className={styles.field}>
                <label htmlFor={nameId} className={styles.label}>Name</label>
                <Input
                  id={nameId}
                  ref={inputRef}
                  fieldSize="sm"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Projects"
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>

              {kind === 'postType' && (
                <div className={styles.field}>
                  <label htmlFor={slugId} className={styles.label}>Slug</label>
                  <Input
                    id={slugId}
                    fieldSize="sm"
                    value={displayedSlug}
                    onChange={(event) => {
                      setSlugTouched(true)
                      setSlug(slugify(event.target.value))
                    }}
                    placeholder={SLUG_PLACEHOLDER}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <span className={styles.caption}>
                    {slugTouched
                      ? `Entry URLs use /${effectiveSlug || SLUG_PLACEHOLDER}/…`
                      : 'Generated from the name; edit to change entry URLs.'}
                  </span>
                  <div className={styles.routePreview}>
                    <span>Entry URL pattern</span>
                    <code>/{effectiveSlug || SLUG_PLACEHOLDER}/entry-slug</code>
                  </div>
                </div>
              )}

              <div className={styles.labelGrid}>
                <div className={styles.field}>
                  <label htmlFor={singularId} className={styles.label}>Singular label</label>
                  <Input
                    id={singularId}
                    fieldSize="sm"
                    value={displayedSingular}
                    onChange={(event) => {
                      setSingularTouched(true)
                      setSingularLabel(event.target.value)
                    }}
                    placeholder="Project"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
                <div className={styles.field}>
                  <label htmlFor={pluralId} className={styles.label}>Plural label</label>
                  <Input
                    id={pluralId}
                    fieldSize="sm"
                    value={displayedPlural}
                    onChange={(event) => {
                      setPluralTouched(true)
                      setPluralLabel(event.target.value)
                    }}
                    placeholder="Projects"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
              </div>
            </section>
          </div>
        </div>

        <div className={styles.schemaPane}>
          <FieldSchemaComposer
            fields={fields}
            tables={tables}
            onChange={(nextFields) => {
              setFieldsByKind((current) => ({ ...current, [editableKind]: nextFields }))
              const candidates = nextFields.filter(isPrimaryFieldCandidate)
              if (!candidates.some((field) => field.id === primaryFieldId)) {
                setPrimaryFieldsByKind((current) => ({
                  ...current,
                  [editableKind]: candidates[0]?.id ?? '',
                }))
              }
            }}
            title="Record structure"
            primaryFieldId={primaryFieldId}
            onPrimaryFieldChange={(fieldId) => {
              setPrimaryFieldsByKind((current) => ({
                ...current,
                [editableKind]: fieldId,
              }))
            }}
          />

        </div>
      </form>
    </Dialog>
  )
}
