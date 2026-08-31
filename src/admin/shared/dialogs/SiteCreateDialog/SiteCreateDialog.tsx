import { useId, useRef, useState, type FormEvent } from 'react'
import type { Page } from '@core/page-tree'
import {
  createUniquePageSlug,
  normalizePageSlug,
  pageSlugDuplicateError,
  pageSlugError,
} from '@core/page-tree'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import { Input } from '@ui/components/Input'
import type { SiteCreateKind } from './siteItemNames'
import styles from './SiteCreateDialog.module.css'

export type { SiteCreateKind } from './siteItemNames'

export interface SiteCreatePayload {
  name: string
  slug?: string
}

interface SiteCreateDialogProps {
  kind: SiteCreateKind
  pages?: Page[]
  onCancel: () => void
  onCreate: (payload: SiteCreatePayload) => void
}

const COPY: Record<SiteCreateKind, { title: string; placeholder: string }> = {
  page: { title: 'New page', placeholder: 'About' },
  component: { title: 'New component', placeholder: 'Hero card' },
  style: { title: 'New stylesheet', placeholder: 'theme' },
  script: { title: 'New script', placeholder: 'analytics' },
}

const FORM_ID = 'site-create-form'

export function SiteCreateDialog({
  kind,
  pages = [],
  onCancel,
  onCreate,
}: SiteCreateDialogProps) {
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugTouched, setSlugTouched] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const nameInputId = useId()
  const slugInputId = useId()
  const copy = COPY[kind]
  const trimmedName = name.trim()
  const isPage = kind === 'page'
  const generatedSlug = isPage && trimmedName ? createUniquePageSlug(trimmedName, pages) : ''
  const pageSlug = slugTouched ? slug : generatedSlug
  const slugError = isPage && trimmedName
    ? pageSlugError(pageSlug) || pageSlugDuplicateError(pageSlug, pages)
    : null

  function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (!trimmedName) return
    if (slugError) return
    onCreate(isPage ? { name: trimmedName, slug: pageSlug } : { name: trimmedName })
  }

  return (
    <Dialog
      open
      onClose={onCancel}
      title={copy.title}
      size="sm"
      initialFocusRef={inputRef}
      footer={
        <>
          <Button variant="secondary" size="sm" type="button" onClick={onCancel}>
            Cancel
          </Button>
          {/* `form` attribute associates this submit button with the form
              that lives in the dialog body. Standard HTML — works across the
              portal boundary, no extra plumbing needed. */}
          <Button
            variant="primary"
            size="sm"
            type="submit"
            form={FORM_ID}
            disabled={!trimmedName || Boolean(slugError)}
          >
            Create
          </Button>
        </>
      }
    >
      <form id={FORM_ID} className={styles.form} onSubmit={handleSubmit}>
        <div className={styles.field}>
          <label htmlFor={nameInputId} className={styles.label}>Name</label>
          <Input
            id={nameInputId}
            ref={inputRef}
            fieldSize="sm"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={copy.placeholder}
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        {isPage && (
          <div className={styles.field}>
            <label htmlFor={slugInputId} className={styles.label}>Slug</label>
            <Input
              id={slugInputId}
              fieldSize="sm"
              value={pageSlug}
              onChange={(event) => {
                setSlugTouched(true)
                setSlug(normalizePageSlug(event.target.value))
              }}
              placeholder="about"
              autoComplete="off"
              spellCheck={false}
              invalid={Boolean(slugError)}
              aria-describedby={slugError ? 'site-create-slug-error' : undefined}
            />
            {slugError && (
              <p id="site-create-slug-error" role="alert" className={styles.errorText}>
                {slugError}
              </p>
            )}
          </div>
        )}
      </form>
    </Dialog>
  )
}
