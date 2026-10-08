import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import type { Page, PageSeo } from '@core/page-tree'
import {
  isHomePage,
  normalizePageSlug,
  pageSlugDuplicateError,
  pageSlugError,
  parsePageTranslationGroup,
} from '@core/page-tree'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import { Input } from '@ui/components/Input'
import { canonicalLanguage } from '@core/localization'
import { getErrorMessage } from '@core/utils/errorMessage'
import { PageSeoFields } from './PageSeoFields'
import { usePageSeoEditor } from './usePageSeoEditor'
import dialogStyles from '../SiteCreateDialog/SiteCreateDialog.module.css'

export interface PageSettingsPayload {
  title: string
  slug: string
  seo?: PageSeo
  language?: string
  translationGroup?: string
}

interface PageSettingsDialogProps {
  page: Page
  pages: Page[]
  canEditStructure?: boolean
  canEditSeo?: boolean
  onCancel: () => void
  onSave: (payload: PageSettingsPayload) => void
}

const FORM_ID = 'page-settings-form'

/**
 * Title + slug editor for a regular page. The site explorer's inline rename
 * only ever changes the title (`renamePage(id, title)` with no third arg
 * leaves the slug untouched) — this dialog is the one place a page's slug
 * can actually be changed after creation.
 */
export function PageSettingsDialog({
  page,
  pages,
  onCancel,
  onSave,
  canEditSeo = true,
  canEditStructure = true,
}: PageSettingsDialogProps) {
  const [title, setTitle] = useState(page.title)
  const [slug, setSlug] = useState(page.slug)
  const [language, setLanguage] = useState(page.language ?? '')
  const [translationGroup, setTranslationGroup] = useState(page.translationGroup ?? '')
  const seoEditor = usePageSeoEditor(page.seo)
  const isHome = isHomePage(page)
  const inputRef = useRef<HTMLInputElement>(null)
  const titleInputId = useId()
  const slugInputId = useId()
  const languageInputId = useId()
  const translationGroupInputId = useId()

  const trimmedTitle = title.trim()
  const normalizedSlug = normalizePageSlug(slug)
  const slugValidation = isHome
    ? null
    : pageSlugError(normalizedSlug) || pageSlugDuplicateError(normalizedSlug, pages, page.id)

  let languageValidation: string | null = null
  try {
    if (language.trim()) canonicalLanguage(language)
  } catch (error) {
    languageValidation = getErrorMessage(error, 'Invalid language tag')
  }
  let translationValidation: string | null = null
  try {
    const group = parsePageTranslationGroup(translationGroup.trim(), 'translationGroup')
    if (group && !language.trim()) translationValidation = 'Choose an explicit language for a translated page.'
    if (group && language.trim()) {
      const tag = canonicalLanguage(language)
      if (pages.some((candidate) => candidate.id !== page.id && candidate.translationGroup === group && candidate.language && canonicalLanguage(candidate.language) === tag)) {
        translationValidation = 'This translation group already contains a page in that language.'
      }
    }
  } catch (error) {
    translationValidation = getErrorMessage(error, 'Invalid page translation group')
  }
  const saveDisabled = Boolean(translationValidation) || !trimmedTitle || Boolean(slugValidation) || Boolean(seoEditor.error) || Boolean(languageValidation)

  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.select())
  }, [])

  function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (saveDisabled) return
    onSave({ title: trimmedTitle, slug: isHome ? page.slug : normalizedSlug, seo: seoEditor.value,
      ...(translationGroup.trim() ? { translationGroup: translationGroup.trim() } : {}),
      ...(language.trim() ? { language: canonicalLanguage(language) } : {}),
    })
  }

  return (
    <Dialog
      open
      onClose={onCancel}
      title="Page settings"
      size="md"
      initialFocusRef={canEditStructure ? inputRef : undefined}
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
            disabled={!canEditStructure}
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
            disabled={isHome || !canEditStructure}
            invalid={Boolean(slugValidation)}
          />
          {isHome ? (
            <p className={dialogStyles.label}>The homepage is always served at &ldquo;/&rdquo;.</p>
          ) : slugValidation ? (
            <p role="alert" className={dialogStyles.errorText}>{slugValidation}</p>
          ) : null}
        </div>
        <div className={dialogStyles.field}>
          <label htmlFor={languageInputId} className={dialogStyles.label}>Language</label>
          <Input id={languageInputId} fieldSize="sm" value={language} disabled={!canEditStructure}
            placeholder="Inherit site language" onChange={(event) => setLanguage(event.target.value)}
            invalid={Boolean(languageValidation)} spellCheck={false} autoComplete="off" />
          {languageValidation && <p role="alert" className={dialogStyles.errorText}>{languageValidation}</p>}
        </div>
        <div className={dialogStyles.field}>
          <label htmlFor={translationGroupInputId} className={dialogStyles.label}>Translation group</label>
          <Input id={translationGroupInputId} fieldSize="sm" value={translationGroup}
            disabled={!canEditStructure} onChange={(event) => setTranslationGroup(event.target.value)}
            invalid={Boolean(translationValidation)} autoComplete="off" spellCheck={false} />
          <p className={dialogStyles.label}>Use the same group for versions of this page in other languages.</p>
          {translationValidation && <p role="alert" className={dialogStyles.errorText}>{translationValidation}</p>}
        </div>
        <PageSeoFields editor={seoEditor} editable={canEditSeo} />
      </form>
    </Dialog>
  )
}
