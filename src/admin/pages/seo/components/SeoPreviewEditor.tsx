/**
 * SeoPreviewEditor — the Meta tab's workbench for one page / template / post
 * target: the sectioned metadata form plus a sticky rail of live 1:1
 * platform previews (Google, Open Graph, X, collapsible JSON-LD). Rendered
 * as a fragment — form and rail are siblings in MetaTab's three-column
 * grid (index | form | previews). One draft, one resolver — every
 * keystroke re-resolves and the rail re-renders, so what's previewed is
 * exactly what the publisher will emit.
 *
 * The header carries a live score chip and an actionable improvements list
 * (both recomputed from the draft on every keystroke — fixing a check turns
 * the score in real time). Each improvement focuses the field it's about.
 *
 * Save/publish: the editor registers itself on the workspace save bridge —
 * the toolbar's PublishActionGroup drives `handleSave` / `handlePublish`.
 * Posts publish incrementally through the row endpoint; pages/templates go
 * live with the step-up-gated full site publish, exactly like the Site
 * toolbar.
 *
 * Form sections: Search appearance → Social card (Open Graph) → X card
 * (behind the customize gate while inheriting). Controlled Input/Textarea
 * primitives only; empty fields show their resolved fallback as placeholder.
 */
import { useId, useState } from 'react'
import { Button } from '@ui/components/Button'
import { Input, Textarea } from '@ui/components/Input'
import { Select } from '@ui/components/Select'
import { Separator } from '@ui/components/Separator'
import { getErrorMessage } from '@core/utils/errorMessage'
import { isSafeCanonicalUrl, computeSeoReport, type SeoCheckId } from '@core/seo'
import { publishCmsDataRow, publishCmsDraft } from '@core/persistence'
import { hasCapability, canPublishContentEntry } from '@admin/access'
import { useCurrentAdminUser } from '@admin/sessionContext'
import { StepUpCancelledMessage, useStepUp } from '@admin/shared/StepUp'
import { cn } from '@ui/cn'
import type { SeoTarget } from '../lib/seoApi'
import { resolveTargetSeo, templateForPost } from '../lib/resolveTargetSeo'
import type { SeoWorkspace } from '../hooks/useSeoWorkspace'
import type { SeoSaveBridge } from '../hooks/useSeoSaveBridge'
import { useSeoSaveSurface } from '../hooks/useSeoSaveBridge'
import { useSeoDraft, normalizeSeoDraft, type SeoDraftField } from '../hooks/useSeoDraft'
import { SeoPreviewRail } from './SeoPreviewRail'
import { SeoScoreChip } from './SeoScoreChip'
import { MetaLengthMeter } from './MetaLengthMeter'
import { SeoImageField } from './SeoImageField'
import { useAiSuggestions } from '../hooks/useAiSuggestions'
import { AiSuggestionSparkle, AiSuggestionResults } from './AiSuggestionBubbles'
import { SeoFormRow, SeoSwitchRow } from './SeoFormRow'
import styles from './SeoPreviewEditor.module.css'

interface SeoPreviewEditorProps {
  target: SeoTarget
  workspace: SeoWorkspace
  canManage: boolean
  bridge: SeoSaveBridge
}

/** Field-id suffix each report check focuses when clicked. */
const CHECK_FIELD: Record<SeoCheckId, SeoDraftField | 'noindex'> = {
  title: 'title',
  description: 'description',
  canonical: 'canonicalUrl',
  socialImage: 'ogImage',
  imageAlt: 'ogImageAlt',
  indexable: 'noindex',
}

export function SeoPreviewEditor({ target, workspace, canManage, bridge }: SeoPreviewEditorProps) {
  const draft = useSeoDraft(target.seo)
  const fieldIdBase = useId()
  const currentUser = useCurrentAdminUser()
  const { runStepUp } = useStepUp()

  // Posts publish incrementally through the row endpoint; pages/templates go
  // live with a full site publish (their rendered output lives in the site
  // snapshot). Both make THIS target's saved SEO live immediately.
  const canPublish = target.kind === 'post'
    ? !currentUser || canPublishContentEntry(currentUser, null) || hasCapability(currentUser, 'content.publish.any')
    : !currentUser || hasCapability(currentUser, 'pages.publish')

  const resolved = resolveTargetSeo(target, draft.draft, workspace.resolveContext)
  const report = computeSeoReport(draft.draft, resolved)
  const template = templateForPost(target, workspace.targets)
  const canonicalValue = draft.draft.canonicalUrl ?? ''
  const canonicalInvalid = canonicalValue !== '' && !isSafeCanonicalUrl(canonicalValue)
  const routePath = target.route ?? '/'

  async function handleSave(): Promise<boolean> {
    if (canonicalInvalid) {
      draft.markError('Canonical URL must be an absolute http(s) URL')
      return false
    }
    draft.markSaving()
    try {
      const normalized = normalizeSeoDraft(draft.draft)
      await workspace.saveTarget(target.kind, target.id, normalized)
      draft.markSaved(normalized)
      return true
    } catch (err) {
      console.error('[seo-page] save failed:', err)
      draft.markError(getErrorMessage(err, 'Could not save SEO metadata'))
      return false
    }
  }

  async function handlePublish(): Promise<void> {
    if (draft.isDirty || draft.saveState === 'error') {
      const saved = await handleSave()
      if (!saved) return
    }
    draft.markPublishing()
    try {
      if (target.kind === 'post') {
        await publishCmsDataRow(target.id)
      } else {
        // Full site publish — same action as the Site toolbar's Publish
        // button (step-up gated). Publishes every pending site draft.
        await runStepUp(() => publishCmsDraft())
      }
      draft.markPublished()
    } catch (err) {
      // A cancelled step-up is a normal flow, not an error to surface.
      if (err instanceof Error && err.message === StepUpCancelledMessage) {
        draft.markSaved(normalizeSeoDraft(draft.draft))
        return
      }
      console.error('[seo-page] publish failed:', err)
      draft.markError(getErrorMessage(err, 'Could not publish'))
    }
  }

  useSeoSaveSurface(
    bridge,
    {
      dirty: draft.isDirty,
      state: draft.saveState,
      canSave: canManage,
      canPublish,
      publishScope: target.kind === 'post' ? 'row' : 'site',
      liveUrl: workspace.publicOrigin && target.route ? `${workspace.publicOrigin}${target.route}` : null,
    },
    { save: () => void handleSave(), publish: () => void handlePublish() },
  )

  function focusCheckField(id: SeoCheckId): void {
    const element = document.getElementById(`${fieldIdBase}-${CHECK_FIELD[id]}`)
    if (!element) return
    element.scrollIntoView({ behavior: 'smooth', block: 'center' })
    element.focus({ preventScroll: true })
  }

  const xCustomized =
    draft.draft.xTitle !== undefined ||
    draft.draft.xDescription !== undefined ||
    draft.draft.xImage !== undefined ||
    draft.draft.xImageAlt !== undefined ||
    draft.draft.xCard !== undefined
  const [xExpanded, setXExpanded] = useState(false)
  const showXFields = xCustomized || xExpanded

  function field(field: SeoDraftField, label: string, opts?: {
    textarea?: boolean
    meterBudget?: 'title' | 'description'
    invalid?: boolean
    sparkle?: boolean
  }) {
    return (
      <MetaField
        field={field}
        label={label}
        id={`${fieldIdBase}-${field}`}
        value={draft.draft[field] ?? ''}
        placeholder={resolvedPlaceholder(field)}
        disabled={!canManage}
        target={target}
        canManage={canManage}
        textarea={opts?.textarea}
        invalid={opts?.invalid}
        sparkle={opts?.sparkle}
        meterBudget={opts?.meterBudget}
        meterText={opts?.meterBudget === 'title' ? resolved.title : resolved.description ?? ''}
        onChange={(value) => draft.setField(field, value)}
      />
    )
  }

  function resolvedPlaceholder(field: SeoDraftField): string {
    switch (field) {
      case 'title': return resolved.title
      case 'description': return resolved.description ?? 'No description — add one or set a site default'
      case 'canonicalUrl': return resolved.canonicalUrl ?? 'Derived from the public origin'
      case 'ogTitle': return resolved.ogTitle
      case 'ogDescription': return resolved.ogDescription ?? ''
      case 'ogImage': return resolved.ogImage ?? ''
      case 'ogImageAlt': return resolved.ogImageAlt ?? ''
      case 'xTitle': return resolved.xTitle
      case 'xDescription': return resolved.xDescription ?? ''
      case 'xImage': return resolved.xImage ?? ''
      case 'xImageAlt': return resolved.xImageAlt ?? ''
    }
  }

  const openIssues = report.checks.filter((check) => check.status !== 'pass')

  return (
    <>
      <section className={styles.form} aria-label={`SEO for ${target.title}`}>
        <header className={styles.header}>
          <div className={styles.headerText}>
            <h2 className={styles.headerTitle}>{target.title}</h2>
            <span className={styles.headerRoute}>
              {target.route ??
                (target.kind === 'template'
                  ? `Entry template · ${(target.templateTableSlugs ?? []).join(', ')}`
                  : '')}
            </span>
          </div>
          <SeoScoreChip score={report.score} />
        </header>
        {draft.saveError && <p className={styles.error} role="alert">{draft.saveError}</p>}
        {!canManage && (
          <p className={styles.readOnlyNote} role="status">
            Read-only — your role does not include Manage SEO.
          </p>
        )}
        {target.kind === 'template' && (
          <p className={styles.templateNote} role="status">
            Template defaults — title and description act as patterns
            (<code>{'{currentEntry.title}'}</code>, <code>{'{site.name}'}</code>) for every matching post.
          </p>
        )}
        {template && (
          <p className={styles.templateNote} role="status">
            Inherits patterns from the “{template.title}” entry template.
          </p>
        )}

        {openIssues.length > 0 && (
          <div className={styles.improvements} role="list" aria-label="Suggested improvements">
            {openIssues.map((check) => (
              /* §8.11 — full-width two-line advice rows; see
                 button-primitive-usage.test.ts ALLOWLIST. */
              <button
                key={check.id}
                type="button"
                role="listitem"
                className={styles.improvement}
                onClick={() => focusCheckField(check.id)}
                data-testid={`seo-improvement-${check.id}`}
              >
                <span
                  className={cn(styles.improvementDot, check.status === 'fail' && styles.improvementDotFail)}
                  aria-hidden="true"
                />
                <span className={styles.improvementText}>
                  <strong>{check.label}</strong> — {check.advice}
                </span>
              </button>
            ))}
          </div>
        )}

        <h3 className={styles.sectionHeading}>Search appearance</h3>
        {field('title', 'Title', { meterBudget: 'title', sparkle: true })}
        {field('description', 'Description', { textarea: true, meterBudget: 'description', sparkle: true })}
        {field('canonicalUrl', 'Canonical URL', { invalid: canonicalInvalid })}
        {canonicalInvalid && (
          <p className={styles.error} role="alert">Canonical URL must be an absolute http(s) URL.</p>
        )}
        <SeoSwitchRow
          id={`${fieldIdBase}-noindex`}
          label="Exclude from search engines"
          hint="Emits noindex — the page disappears from search and answer engines."
          checked={draft.draft.noindex === true}
          disabled={!canManage}
          onCheckedChange={draft.setNoindex}
        />

        <Separator />
        <h3 className={styles.sectionHeading}>Social card (Open Graph)</h3>
        {field('ogTitle', 'OG title', { sparkle: true })}
        {field('ogDescription', 'OG description', { textarea: true, sparkle: true })}
        <SeoImageField
          label="OG image"
          fieldId={`${fieldIdBase}-ogImage`}
          value={draft.draft.ogImage ?? ''}
          inheritedValue={resolved.ogImage ?? null}
          disabled={!canManage}
          onChange={(next) => draft.setField('ogImage', next)}
        />
        {field('ogImageAlt', 'OG image alt')}
        <SeoFormRow label="OG type" htmlFor={`${fieldIdBase}-ogType`}>
          <Select
            id={`${fieldIdBase}-ogType`}
            value={draft.draft.ogType ?? ''}
            disabled={!canManage}
            onChange={(e) => draft.setOgType(e.target.value === '' ? undefined : (e.target.value as 'website' | 'article'))}
          >
            <option value="">Auto ({resolved.ogType})</option>
            <option value="website">website</option>
            <option value="article">article</option>
          </Select>
        </SeoFormRow>

        <Separator />
        <h3 className={styles.sectionHeading}>X card</h3>
        {!showXFields ? (
          <div className={styles.customizeRow}>
            <p className={styles.customizeHint}>
              X uses the Open Graph values until customized.
            </p>
            <Button variant="secondary" size="sm" disabled={!canManage} onClick={() => setXExpanded(true)} data-testid="seo-customize-x">
              Customize X preview
            </Button>
          </div>
        ) : (
          <>
            {field('xTitle', 'X title', { sparkle: true })}
            {field('xDescription', 'X description', { textarea: true, sparkle: true })}
            <SeoImageField
              label="X image"
              value={draft.draft.xImage ?? ''}
              inheritedValue={resolved.xImage ?? null}
              disabled={!canManage}
              onChange={(next) => draft.setField('xImage', next)}
            />
            {field('xImageAlt', 'X image alt')}
            <SeoFormRow label="Card type" htmlFor={`${fieldIdBase}-xCard`}>
              <Select
                id={`${fieldIdBase}-xCard`}
                value={draft.draft.xCard ?? ''}
                disabled={!canManage}
                onChange={(e) => draft.setXCard(e.target.value === '' ? undefined : (e.target.value as 'summary' | 'summary_large_image'))}
              >
                <option value="">Auto ({resolved.xCard})</option>
                <option value="summary">summary</option>
                <option value="summary_large_image">summary_large_image</option>
              </Select>
            </SeoFormRow>
          </>
        )}
      </section>

      <SeoPreviewRail
        resolved={resolved}
        workspace={workspace}
        routePath={routePath}
        schemaTarget={target}
      />
    </>
  )
}

interface MetaFieldProps {
  field: SeoDraftField
  label: string
  id: string
  value: string
  placeholder: string
  disabled: boolean
  target: SeoTarget
  canManage: boolean
  textarea?: boolean
  invalid?: boolean
  sparkle?: boolean
  meterBudget?: 'title' | 'description'
  /** Resolved text the meter measures when the value is inherited. */
  meterText?: string
  onChange: (value: string) => void
}

/**
 * One metadata field row in the two-column grid: label (+ AI sparkle
 * trigger) in the label cell; input, length meter, and the sparkle's
 * error/suggestion bubbles stacked in the control column.
 */
function MetaField({
  field,
  label,
  id,
  value,
  placeholder,
  disabled,
  target,
  canManage,
  textarea,
  invalid,
  sparkle,
  meterBudget,
  meterText,
  onChange,
}: MetaFieldProps) {
  const ai = useAiSuggestions(target, field, onChange)
  const common = {
    id,
    value,
    placeholder,
    disabled,
    'aria-invalid': invalid || undefined,
  }
  return (
    <SeoFormRow
      label={label}
      htmlFor={id}
      labelAction={sparkle ? <AiSuggestionSparkle ai={ai} canManage={canManage} /> : undefined}
    >
      {textarea ? (
        <Textarea {...common} rows={3} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <Input {...common} type="text" onChange={(e) => onChange(e.target.value)} />
      )}
      {meterBudget && (
        /* Inherited values meter against the RESOLVED text, never the
           input's hint placeholder ("No description — add one…"). */
        <MetaLengthMeter
          text={value !== '' ? value : meterText ?? ''}
          budget={meterBudget}
          explicit={value !== ''}
        />
      )}
      <AiSuggestionResults ai={ai} />
    </SeoFormRow>
  )
}
