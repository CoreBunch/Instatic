/**
 * SiteDefaultsEditor — the pinned "Site defaults" target's workbench.
 *
 * Rendered as a fragment into MetaTab's three-column grid: the sectioned
 * defaults form (`site.settings.seo`: title pattern, description, default
 * social image, X handle/card, and the Organization fields feeding
 * site-wide JSON-LD), then a rail of live previews of the HOMEPAGE
 * resolved with the draft defaults applied — the user sees exactly what a
 * typical page inherits while they type the pattern. Robots/sitemap
 * settings live on the same object but are edited in their own tabs.
 */
import { useId, useState } from 'react'
import { Input, Textarea } from '@ui/components/Input'
import { Select } from '@ui/components/Select'
import { Separator } from '@ui/components/Separator'
import { getErrorMessage } from '@core/utils/errorMessage'
import type { SiteSeoSettings } from '@core/seo'
import { publishCmsDraft } from '@core/persistence'
import { hasCapability } from '@admin/access'
import { useCurrentAdminUser } from '@admin/sessionContext'
import { StepUpCancelledMessage, useStepUp } from '@admin/shared/StepUp'
import type { SeoWorkspace } from '../hooks/useSeoWorkspace'
import type { SeoSaveBridge } from '../hooks/useSeoSaveBridge'
import { useSeoSaveSurface } from '../hooks/useSeoSaveBridge'
import { resolveTargetSeo } from '../lib/resolveTargetSeo'
import { SeoPreviewRail } from './SeoPreviewRail'
import { SeoImageField } from './SeoImageField'
import { SeoFormRow } from './SeoFormRow'
import styles from './SeoPreviewEditor.module.css'

type SiteStringField =
  | 'titlePattern'
  | 'description'
  | 'defaultOgImage'
  | 'defaultOgImageAlt'
  | 'xSiteHandle'

function normalizeSiteSeo(draft: SiteSeoSettings): SiteSeoSettings {
  const next: SiteSeoSettings = {}
  const stringFields: SiteStringField[] = ['titlePattern', 'description', 'defaultOgImage', 'defaultOgImageAlt', 'xSiteHandle']
  for (const key of stringFields) {
    const value = draft[key]
    if (typeof value === 'string' && value.trim() !== '') next[key] = value.trim()
  }
  if (draft.defaultXCard !== undefined) next.defaultXCard = draft.defaultXCard
  const orgName = draft.organization?.name?.trim() ?? ''
  const orgLogo = draft.organization?.logoUrl?.trim() ?? ''
  if (orgName !== '' || orgLogo !== '') {
    next.organization = {
      ...(orgName !== '' ? { name: orgName } : {}),
      ...(orgLogo !== '' ? { logoUrl: orgLogo } : {}),
    }
  }
  if (draft.robots !== undefined) next.robots = draft.robots
  if (draft.sitemap !== undefined) next.sitemap = draft.sitemap
  return next
}

function sameSiteSeo(a: SiteSeoSettings, b: SiteSeoSettings): boolean {
  return JSON.stringify(normalizeSiteSeo(a)) === JSON.stringify(normalizeSiteSeo(b))
}

interface SiteDefaultsEditorProps {
  workspace: SeoWorkspace
  canManage: boolean
  bridge: SeoSaveBridge
}

export function SiteDefaultsEditor({ workspace, canManage, bridge }: SiteDefaultsEditorProps) {
  const stored = workspace.siteSeo ?? {}
  const [draft, setDraft] = useState<SiteSeoSettings>(stored)
  const [baseline, setBaseline] = useState<SiteSeoSettings>(stored)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'publishing' | 'published' | 'error'>('idle')
  const [saveError, setSaveError] = useState<string | null>(null)
  const idBase = useId()
  const currentUser = useCurrentAdminUser()
  const { runStepUp } = useStepUp()
  const canPublish = !currentUser || hasCapability(currentUser, 'pages.publish')

  const isDirty = !sameSiteSeo(draft, baseline)

  // Rail sample: the homepage (or any page) resolved with the DRAFT defaults
  // overlayed — live "what a typical page inherits" feedback while typing.
  const sampleTarget =
    workspace.targets.find((target) => target.kind === 'page' && target.route === '/') ??
    workspace.targets.find((target) => target.kind === 'page') ??
    null
  const sampleResolved = sampleTarget
    ? resolveTargetSeo(sampleTarget, sampleTarget.seo ?? undefined, {
        ...workspace.resolveContext,
        siteSeo: draft,
      })
    : null

  function setField(field: SiteStringField, value: string): void {
    setDraft((current) => {
      const next = { ...current }
      if (value === '') delete next[field]
      else next[field] = value
      return next
    })
    if (saveState !== 'idle') setSaveState('idle')
  }

  function setOrgField(field: 'name' | 'logoUrl', value: string): void {
    setDraft((current) => {
      const organization = { ...current.organization }
      if (value === '') delete organization[field]
      else organization[field] = value
      const next = { ...current }
      if (Object.keys(organization).length === 0) delete next.organization
      else next.organization = organization
      return next
    })
    if (saveState !== 'idle') setSaveState('idle')
  }

  async function handleSave(): Promise<boolean> {
    setSaveState('saving')
    setSaveError(null)
    try {
      const normalized = normalizeSiteSeo(draft)
      await workspace.saveSite(normalized)
      setBaseline(normalized)
      setDraft(normalized)
      setSaveState('saved')
      return true
    } catch (err) {
      console.error('[seo-page] site defaults save failed:', err)
      setSaveState('error')
      setSaveError(getErrorMessage(err, 'Could not save site SEO defaults'))
      return false
    }
  }

  async function handlePublish(): Promise<void> {
    if (isDirty && !(await handleSave())) return
    setSaveState('publishing')
    try {
      // Full site publish — step-up gated, same as the Site toolbar.
      await runStepUp(() => publishCmsDraft())
      setSaveState('published')
    } catch (err) {
      if (err instanceof Error && err.message === StepUpCancelledMessage) {
        setSaveState('saved')
        return
      }
      console.error('[seo-page] publish failed:', err)
      setSaveState('error')
      setSaveError(getErrorMessage(err, 'Could not publish'))
    }
  }

  useSeoSaveSurface(
    bridge,
    {
      dirty: isDirty,
      state: saveState,
      canSave: canManage,
      canPublish,
      publishScope: 'site',
      liveUrl: workspace.publicOrigin,
    },
    { save: () => void handleSave(), publish: () => void handlePublish() },
  )

  return (
    <>
      <section className={styles.form} aria-label="Site SEO defaults">
        <header className={styles.header}>
          <div className={styles.headerText}>
            <h2 className={styles.headerTitle}>Site defaults</h2>
            <span className={styles.headerRoute}>
              {sampleTarget ? `Previewing “${sampleTarget.title}” with these defaults` : 'Fallbacks for every page and post'}
            </span>
          </div>
        </header>
        {saveError && <p className={styles.error} role="alert">{saveError}</p>}
        {!canManage && (
          <p className={styles.readOnlyNote} role="status">
            Read-only — your role does not include Manage SEO.
          </p>
        )}
        {!workspace.siteSeo && !isDirty && (
          <p className={styles.templateNote} role="status">
            No site defaults yet — set a title pattern and description so every
            target has sensible metadata out of the box.
          </p>
        )}

        <h3 className={styles.sectionHeading}>Defaults</h3>
        <SeoFormRow label="Title pattern" htmlFor={`${idBase}-pattern`}>
          <Input
            id={`${idBase}-pattern`}
            type="text"
            value={draft.titlePattern ?? ''}
            placeholder="{page.title} — {site.name}"
            disabled={!canManage}
            onChange={(e) => setField('titlePattern', e.target.value)}
          />
          <p className={styles.fieldHint}>
            Tokens: <code>{'{page.title}'}</code>, <code>{'{site.name}'}</code>, <code>{'{currentEntry.title}'}</code>.
            Targets with an explicit SEO title skip the pattern.
          </p>
        </SeoFormRow>

        <SeoFormRow label="Site description" htmlFor={`${idBase}-description`}>
          <Textarea
            id={`${idBase}-description`}
            rows={3}
            value={draft.description ?? ''}
            placeholder="Used when a page or post has no description of its own."
            disabled={!canManage}
            onChange={(e) => setField('description', e.target.value)}
          />
        </SeoFormRow>

        <SeoImageField
          label="Default social image"
          value={draft.defaultOgImage ?? ''}
          inheritedValue={null}
          disabled={!canManage}
          onChange={(next) => setField('defaultOgImage', next)}
        />

        <SeoFormRow label="Default image alt text" htmlFor={`${idBase}-ogalt`}>
          <Input
            id={`${idBase}-ogalt`}
            type="text"
            value={draft.defaultOgImageAlt ?? ''}
            disabled={!canManage}
            onChange={(e) => setField('defaultOgImageAlt', e.target.value)}
          />
        </SeoFormRow>

        <SeoFormRow label="Default X card" htmlFor={`${idBase}-xcard`}>
          <Select
            id={`${idBase}-xcard`}
            value={draft.defaultXCard ?? ''}
            disabled={!canManage}
            onChange={(e) => {
              const value = e.target.value
              setDraft((current) => {
                const next = { ...current }
                if (value === '') delete next.defaultXCard
                else next.defaultXCard = value as 'summary' | 'summary_large_image'
                return next
              })
              if (saveState !== 'idle') setSaveState('idle')
            }}
          >
            <option value="">Auto (large when an image is set)</option>
            <option value="summary">summary</option>
            <option value="summary_large_image">summary_large_image</option>
          </Select>
        </SeoFormRow>

        <SeoFormRow label="X site handle" htmlFor={`${idBase}-xhandle`}>
          <Input
            id={`${idBase}-xhandle`}
            type="text"
            value={draft.xSiteHandle ?? ''}
            placeholder="@yoursite"
            disabled={!canManage}
            onChange={(e) => setField('xSiteHandle', e.target.value)}
          />
        </SeoFormRow>

        <Separator />
        <h3 className={styles.sectionHeading}>Organization (structured data)</h3>
        <p className={styles.fieldHint}>
          Emitted as schema.org <code>Organization</code> JSON-LD on the homepage —
          how answer engines identify who runs this site.
        </p>

        <SeoFormRow label="Organization name" htmlFor={`${idBase}-orgname`}>
          <Input
            id={`${idBase}-orgname`}
            type="text"
            value={draft.organization?.name ?? ''}
            disabled={!canManage}
            onChange={(e) => setOrgField('name', e.target.value)}
          />
        </SeoFormRow>

        <SeoImageField
          label="Organization logo"
          value={draft.organization?.logoUrl ?? ''}
          inheritedValue={null}
          disabled={!canManage}
          onChange={(next) => setOrgField('logoUrl', next)}
        />
      </section>

      {sampleResolved && sampleTarget && (
        <SeoPreviewRail
          resolved={sampleResolved}
          workspace={workspace}
          routePath={sampleTarget.route ?? '/'}
          schemaTarget={sampleTarget}
        />
      )}
    </>
  )
}
