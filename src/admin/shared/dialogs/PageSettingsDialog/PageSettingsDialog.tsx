import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import type { Page } from '@core/page-tree'
import {
  isHomePage,
  normalizePageSlug,
  pageSlugDuplicateError,
  pageSlugError,
} from '@core/page-tree'
import { PUBLIC_ACCESS, type AccessRule } from '@core/members'
import { AccessRuleEditor, isCompleteAccessRule } from '@admin/shared/AccessRuleEditor'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import { Input } from '@ui/components/Input'
import dialogStyles from '../SiteCreateDialog/SiteCreateDialog.module.css'

export interface PageSettingsPayload {
  title: string
  slug: string
  access: AccessRule
}

interface PageSettingsDialogProps {
  page: Page
  pages: Page[]
  onCancel: () => void
  onSave: (payload: PageSettingsPayload) => void
}

const FORM_ID = 'page-settings-form'

/**
 * Title, slug and access for a regular page. The site explorer's inline
 * rename only ever changes the title (`renamePage(id, title)` with no third
 * arg leaves the slug untouched) — this dialog is the one place a page's
 * slug, and who may open the page, can be changed after creation.
 */
export function PageSettingsDialog({
  page,
  pages,
  onCancel,
  onSave,
}: PageSettingsDialogProps) {
  const [title, setTitle] = useState(page.title)
  const [slug, setSlug] = useState(page.slug)
  const [access, setAccess] = useState<AccessRule>(page.access ?? PUBLIC_ACCESS)
  const isHome = isHomePage(page)
  const inputRef = useRef<HTMLInputElement>(null)
  const titleInputId = useId()
  const slugInputId = useId()

  const trimmedTitle = title.trim()
  const normalizedSlug = normalizePageSlug(slug)
  const slugValidation = isHome
    ? null
    : pageSlugError(normalizedSlug) || pageSlugDuplicateError(normalizedSlug, pages, page.id)

  const saveDisabled = !trimmedTitle || Boolean(slugValidation) || !isCompleteAccessRule(access)

  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.select())
  }, [])

  function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (saveDisabled) return
    onSave({ title: trimmedTitle, slug: isHome ? page.slug : normalizedSlug, access })
  }

  return (
    <Dialog
      open
      onClose={onCancel}
      title="Page settings"
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
          <label htmlFor={titleInputId} className={dialogStyles.label}>Title</label>
          <Input
            id={titleInputId}
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
            value={isHome ? page.slug : slug}
            onChange={(event) => setSlug(normalizePageSlug(event.target.value))}
            autoComplete="off"
            spellCheck={false}
            disabled={isHome}
            invalid={Boolean(slugValidation)}
          />
          {isHome ? (
            <p className={dialogStyles.label}>The homepage is always served at &ldquo;/&rdquo;.</p>
          ) : slugValidation ? (
            <p role="alert" className={dialogStyles.errorText}>{slugValidation}</p>
          ) : null}
        </div>

        <fieldset className={dialogStyles.group}>
          <legend className={dialogStyles.groupTitle}>Access</legend>
          <AccessRuleEditor value={access} onChange={setAccess} subject="this page" />
          <p className={dialogStyles.hint}>
            {access.level === 'public'
              ? 'Anyone with the address can open this page.'
              : 'Takes effect when you publish. Until then the published page stays as it is.'}
          </p>
        </fieldset>
      </form>
    </Dialog>
  )
}
