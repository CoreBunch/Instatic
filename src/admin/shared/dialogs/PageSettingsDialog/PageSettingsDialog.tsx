import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import type { Page, PageSeo } from '@core/page-tree'
import {
  isHomePage,
  parsePageSeo,
  normalizePageSlug,
  pageSlugDuplicateError,
  pageSlugError,
} from '@core/page-tree'
import { PUBLIC_ACCESS, type AccessRule } from '@core/members'
import { AccessRuleEditor, isCompleteAccessRule } from '@admin/shared/AccessRuleEditor'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import { Input } from '@ui/components/Input'
import { Tab, TabList, TabPanel, Tabs } from '@ui/components/Tabs'
import { FileTextSolidIcon } from 'pixel-art-icons/icons/file-text-solid'
import { PageSeoTabs, PageSeoTabPanels, pageSeoProblem } from '@admin/shared/PageSeoEditor'
import { buildPageFrame, buildRouteFrame } from '@core/templates'
import dialogStyles from '../SiteCreateDialog/SiteCreateDialog.module.css'

export interface PageSettingsPayload {
  title: string
  slug: string
  access: AccessRule
  /** Normalised head settings; null clears them. */
  seo: PageSeo | null
}

type SettingsTab = 'page' | 'search' | 'head'

interface PageSettingsDialogProps {
  inherited?: PageSeo
  siteFrame?: { id: string; name: string }
  page: Page
  pages: Page[]
  onCancel: () => void
  onSave: (payload: PageSettingsPayload) => void
}

const FORM_ID = 'page-settings-form'

/**
 * Title, slug, access and `<head>` settings for a regular page. The site
 * explorer's inline rename only ever changes the title (`renamePage(id,
 * title)` with no third arg leaves the slug untouched) — this dialog is the
 * one place a page's slug, who may open the page, and its search / social /
 * head tags can be changed after creation.
 */
export function PageSettingsDialog({
  page,
  pages,
  inherited,
  siteFrame,
  onCancel,
  onSave,
}: PageSettingsDialogProps) {
  const [title, setTitle] = useState(page.title)
  const [slug, setSlug] = useState(page.slug)
  const [access, setAccess] = useState<AccessRule>(page.access ?? PUBLIC_ACCESS)
  const [seo, setSeo] = useState<PageSeo>(page.seo ?? {})
  const [tab, setTab] = useState<SettingsTab>('page')
  const isHome = isHomePage(page)
  const inputRef = useRef<HTMLInputElement>(null)
  const titleInputId = useId()
  const slugInputId = useId()

  const trimmedTitle = title.trim()
  const normalizedSlug = normalizePageSlug(slug)
  const slugValidation = isHome
    ? null
    : pageSlugError(normalizedSlug) || pageSlugDuplicateError(normalizedSlug, pages, page.id)

  const pageFrame = buildPageFrame({ ...page, title: trimmedTitle || page.title, slug: normalizedSlug || page.slug })
  const previewContext = { entryStack: [], page: pageFrame, route: buildRouteFrame(pageFrame.permalink), site: siteFrame }
  const seoProblem = pageSeoProblem(seo)
  // The Page tab shows its own errors next to the field; on the other tabs
  // the footer names whatever keeps Save disabled.
  const pageProblem = !trimmedTitle ? 'Give the page a title.' : slugValidation
  const footerProblem = seoProblem ?? (tab !== 'page' ? pageProblem : null)
  const saveDisabled = !trimmedTitle || Boolean(slugValidation) || !isCompleteAccessRule(access) || Boolean(seoProblem)

  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.select())
  }, [])

  function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (saveDisabled) return
    onSave({ title: trimmedTitle, slug: isHome ? page.slug : normalizedSlug, access, seo: parsePageSeo(seo) })
  }

  return (
    <Dialog
      open
      onClose={onCancel}
      title="Page settings"
      size="xl"
      initialFocusRef={inputRef}
      footer={
        <>
          {footerProblem && <p role="alert" className={dialogStyles.errorText}>{footerProblem}</p>}
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
        <Tabs value={tab} onChange={setTab}>
          <TabList ariaLabel="Page settings sections">
            <Tab value="page"><FileTextSolidIcon size={14} aria-hidden="true" />Page</Tab>
            <PageSeoTabs />
          </TabList>
          <TabPanel value="page" keepMounted>
            <div className={dialogStyles.form}>
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
            </div>
          </TabPanel>
          <PageSeoTabPanels inherited={inherited} previewContext={previewContext} value={seo} onChange={setSeo} pageTitle={trimmedTitle || page.title} note="Empty fields inherit from the matching template and global head settings." />
        </Tabs>
      </form>
    </Dialog>
  )
}
