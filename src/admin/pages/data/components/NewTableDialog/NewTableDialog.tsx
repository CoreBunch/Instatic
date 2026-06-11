import { useId, useRef, useState, type FormEvent } from 'react'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import { Input } from '@ui/components/Input'
import { SegmentedControl } from '@ui/components/SegmentedControl'
import { buildPostTypeDefaultFields } from '@core/data/fields'
import { type CreateDataTableInput, type DataTableKind } from '@core/data/schemas'
import { StepUpCancelledMessage } from '@admin/shared/StepUp'
import styles from './NewTableDialog.module.css'
import { getErrorMessage } from '@core/utils/errorMessage'

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function errorMessage(err: unknown): string {
  return getErrorMessage(err, 'Could not create table').replace(/^\[[^\]]+\]\s*/, '')
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface NewTableDialogProps {
  open: boolean
  onClose: () => void
  onCreate: (input: CreateDataTableInput) => Promise<void>
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

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function NewTableDialog({
  open,
  onClose,
  onCreate,
}: NewTableDialogProps) {
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugTouched, setSlugTouched] = useState(false)
  const [kind, setKind] = useState<DataTableKind>('data')
  const [singularLabel, setSingularLabel] = useState('')
  const [singularTouched, setSingularTouched] = useState(false)
  const [pluralLabel, setPluralLabel] = useState('')
  const [pluralTouched, setPluralTouched] = useState(false)
  const [saving, setSaving] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const inputRef = useRef<HTMLInputElement>(null)
  const nameId = useId()
  const slugId = useId()
  const singularId = useId()
  const pluralId = useId()

  // Derived values
  const trimmedName = name.trim()
  const displayedSlug = slugTouched ? slug : (trimmedName ? slugify(trimmedName) : '')
  const effectiveSlug = slugify(displayedSlug || trimmedName)

  const displayedSingular = singularTouched ? singularLabel : trimmedName
  const displayedPlural = pluralTouched ? pluralLabel : (trimmedName ? `${trimmedName}s` : '')

  const canCreate = Boolean(trimmedName && effectiveSlug && !saving)

  function resetForm() {
    setName('')
    setSlug('')
    setSlugTouched(false)
    setKind('data')
    setSingularLabel('')
    setSingularTouched(false)
    setPluralLabel('')
    setPluralTouched(false)
    setSaving(false)
    setSubmitError(null)
  }

  function handleClose() {
    resetForm()
    onClose()
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (!canCreate) return

    const fields =
      kind === 'postType'
        ? buildPostTypeDefaultFields()
        : [{ type: 'text' as const, id: 'name', label: 'Name', required: true }]

    const primaryFieldId = kind === 'postType' ? 'title' : 'name'
    const routeBase = kind === 'postType' ? `/${effectiveSlug}` : ''

    const input: CreateDataTableInput = {
      name: trimmedName,
      slug: effectiveSlug,
      kind,
      routeBase,
      singularLabel: displayedSingular.trim() || trimmedName,
      pluralLabel: displayedPlural.trim() || `${trimmedName}s`,
      primaryFieldId,
      fields,
    }

    setSaving(true)
    setSubmitError(null)
    try {
      await onCreate(input)
      resetForm()
    } catch (err) {
      if (err instanceof Error && err.message === StepUpCancelledMessage) {
        setSaving(false)
        return
      }
      setSubmitError(errorMessage(err))
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title="New table"
      size="sm"
      initialFocusRef={inputRef}
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
        {/* Name */}
        <div className={styles.field}>
          <label htmlFor={nameId} className={styles.label}>Name</label>
          <Input
            id={nameId}
            ref={inputRef}
            fieldSize="sm"
            value={name}
            onChange={(event) => {
              setName(event.target.value)
              setSubmitError(null)
            }}
            placeholder="Products"
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        {/* Slug */}
        <div className={styles.field}>
          <label htmlFor={slugId} className={styles.label}>Slug</label>
          <Input
            id={slugId}
            fieldSize="sm"
            value={displayedSlug}
            onChange={(event) => {
              setSlugTouched(true)
              setSlug(slugify(event.target.value))
              setSubmitError(null)
            }}
            placeholder="products"
            autoComplete="off"
            spellCheck={false}
          />
          {!slugTouched && (
            <span className={styles.caption}>Auto-generated from name</span>
          )}
        </div>

        {/* Kind */}
        <div className={styles.field}>
          <span className={styles.label}>Kind</span>
          <SegmentedControl
            value={kind}
            options={KIND_OPTIONS}
            onChange={setKind}
            fullWidth
          />
          <span className={styles.caption}>{KIND_DESCRIPTIONS[kind]}</span>
        </div>

        {/* Singular label */}
        <div className={styles.field}>
          <label htmlFor={singularId} className={styles.label}>Singular label</label>
          <Input
            id={singularId}
            fieldSize="sm"
            value={displayedSingular}
            onChange={(event) => {
              setSingularTouched(true)
              setSingularLabel(event.target.value)
              setSubmitError(null)
            }}
            placeholder="Product"
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        {/* Plural label */}
        <div className={styles.field}>
          <label htmlFor={pluralId} className={styles.label}>Plural label</label>
          <Input
            id={pluralId}
            fieldSize="sm"
            value={displayedPlural}
            onChange={(event) => {
              setPluralTouched(true)
              setPluralLabel(event.target.value)
              setSubmitError(null)
            }}
            placeholder="Products"
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        {submitError && (
          <p role="alert" className={styles.errorText}>
            {submitError}
          </p>
        )}
      </form>
    </Dialog>
  )
}
