import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { useAsyncResource } from '@admin/lib/useAsyncResource'
import type { Page, PageTemplateConfig, TemplateTarget } from '@core/page-tree'
import {
  normalizePageSlug,
  pageSlugDuplicateError,
  pageSlugError,
} from '@core/page-tree'
import { listCmsDataTables } from '@core/persistence/cmsData'
import type { DataTable } from '@core/data/schemas'
import { Button } from '@ui/components/Button'
import { Checkbox } from '@ui/components/Checkbox'
import { Dialog } from '@ui/components/Dialog'
import { Input } from '@ui/components/Input'
import { Select } from '@ui/components/Select'
import dialogStyles from '../SiteCreateDialog/SiteCreateDialog.module.css'

export interface TemplateSettingsPayload {
  title: string
  slug: string
  template: PageTemplateConfig
}

interface TemplateSettingsDialogProps {
  page: Page
  pages: Page[]
  onCancel: () => void
  onSave: (payload: TemplateSettingsPayload) => void
}

const FALLBACK_COLLECTIONS: DataTable[] = [{
  id: 'posts',
  name: 'Posts',
  slug: 'posts',
  kind: 'postType',
  routeBase: '/posts',
  singularLabel: 'Post',
  pluralLabel: 'Posts',
  primaryFieldId: 'title',
  system: false,
  fields: [],
  createdByUserId: null,
  updatedByUserId: null,
  createdAt: '',
  updatedAt: '',
}]

const FORM_ID = 'template-settings-form'

const TARGET_KIND_OPTIONS = [
  { value: 'everywhere', label: 'Everywhere' },
  { value: 'postTypes', label: 'Post types' },
  { value: 'notFound', label: 'Not found (404)' },
]

export function TemplateSettingsDialog({
  page,
  pages,
  onCancel,
  onSave,
}: TemplateSettingsDialogProps) {
  const initialTarget = page.template?.target
  const [title, setTitle] = useState(page.title)
  const [slug, setSlug] = useState(page.slug)
  const [targetKind, setTargetKind] = useState<TemplateTarget['kind']>(initialTarget?.kind ?? 'everywhere')
  const [selectedSlugs, setSelectedSlugs] = useState<string[]>(
    initialTarget?.kind === 'postTypes' ? initialTarget.tableSlugs : [],
  )
  const [priority, setPriority] = useState(String(page.template?.priority ?? 100))
  // A postTypes template renders an entry at a public URL — only tables with a
  // non-empty `routeBase` are routable and can be a template source (both
  // `postType` and `data` kinds qualify). Falls back to a synthetic Posts table
  // when the load fails or returns nothing routable.
  const { data: loadedCollections } = useAsyncResource(
    async () => {
      const allTables = await listCmsDataTables()
      const routable = allTables.filter((t) => t.routeBase.trim() !== '')
      return routable.length > 0 ? routable : FALLBACK_COLLECTIONS
    },
    [],
    { swallowErrors: true },
  )
  const collections: DataTable[] = loadedCollections ?? FALLBACK_COLLECTIONS
  const inputRef = useRef<HTMLInputElement>(null)
  const nameInputId = useId()
  const slugInputId = useId()
  const targetSelectId = useId()
  const priorityInputId = useId()

  const trimmedTitle = title.trim()
  const normalizedSlug = normalizePageSlug(slug)
  const priorityNumber = Number(priority)
  const slugValidation = pageSlugError(normalizedSlug) || pageSlugDuplicateError(normalizedSlug, pages, page.id)
  const priorityInvalid = !Number.isFinite(priorityNumber)
  const postTypesEmpty = targetKind === 'postTypes' && selectedSlugs.length === 0

  const saveDisabled = !trimmedTitle
    || Boolean(slugValidation)
    || priorityInvalid
    || postTypesEmpty

  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.select())
  }, [])

  function toggleSlug(slugValue: string, checked: boolean) {
    setSelectedSlugs((prev) =>
      checked ? [...prev, slugValue] : prev.filter((s) => s !== slugValue),
    )
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (saveDisabled) return

    const target: TemplateTarget = targetKind === 'postTypes'
      ? { kind: 'postTypes', tableSlugs: selectedSlugs }
      : { kind: targetKind }

    onSave({
      title: trimmedTitle,
      slug: normalizedSlug,
      template: {
        enabled: true,
        target,
        priority: priorityNumber,
      },
    })
  }

  return (
    <Dialog
      open
      onClose={onCancel}
      title="Template settings"
      size="sm"
      initialFocusRef={inputRef}
      footer={
        <>
          <Button variant="secondary" size="sm" type="button" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            type="submit"
            form={FORM_ID}
            disabled={saveDisabled}
          >
            Save
          </Button>
        </>
      }
    >
      <form id={FORM_ID} className={dialogStyles.form} onSubmit={handleSubmit}>
        <div className={dialogStyles.field}>
          <label htmlFor={nameInputId} className={dialogStyles.label}>Name</label>
          <Input
            id={nameInputId}
            ref={inputRef}
            fieldSize="sm"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        <div className={dialogStyles.field}>
          <label htmlFor={slugInputId} className={dialogStyles.label}>Slug</label>
          <Input
            id={slugInputId}
            fieldSize="sm"
            value={slug}
            onChange={(event) => setSlug(normalizePageSlug(event.target.value))}
            autoComplete="off"
            spellCheck={false}
            invalid={Boolean(slugValidation)}
          />
          {slugValidation && (
            <p role="alert" className={dialogStyles.errorText}>{slugValidation}</p>
          )}
        </div>

        <div className={dialogStyles.field}>
          <label htmlFor={targetSelectId} className={dialogStyles.label}>Applies to</label>
          <Select
            id={targetSelectId}
            aria-label="Applies to"
            fieldSize="sm"
            value={targetKind}
            onChange={(event) => setTargetKind(event.target.value as TemplateTarget['kind'])}
            options={TARGET_KIND_OPTIONS}
          />
        </div>

        {targetKind === 'postTypes' && (
          <div className={dialogStyles.field}>
            <span className={dialogStyles.label}>Post types</span>
            {collections.map((collection) => (
              <label key={collection.slug} className={dialogStyles.checkboxRow}>
                <Checkbox
                  checked={selectedSlugs.includes(collection.slug)}
                  onCheckedChange={(checked) => toggleSlug(collection.slug, checked)}
                  aria-label={collection.pluralLabel || collection.name}
                />
                {collection.pluralLabel || collection.name}
              </label>
            ))}
            {postTypesEmpty && (
              <p role="alert" className={dialogStyles.errorText}>Select at least one post type.</p>
            )}
          </div>
        )}

        <div className={dialogStyles.field}>
          <label htmlFor={priorityInputId} className={dialogStyles.label}>Priority</label>
          <Input
            id={priorityInputId}
            aria-label="Priority"
            fieldSize="sm"
            type="number"
            value={priority}
            onChange={(event) => setPriority(event.target.value)}
            invalid={priorityInvalid}
          />
        </div>
      </form>
    </Dialog>
  )
}
