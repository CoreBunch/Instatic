import { ContentLanguagesDialog } from '@admin/shared/ContentLanguagesDialog'
import { useCurrentAdminUser } from '@admin/sessionContext'
import { hasCapability } from '@admin/access'
import type { PublishVariantSelection } from '@core/localization-schema'
import { SitePublishDialog } from '@admin/shared/SitePublishDialog'
import { Select } from '@ui/components/Select'
import { useEffect, useRef, useState } from 'react'
import type { SiteDocument } from '@core/page-tree'
import { selectActivePage, useEditorStore } from '@site/store/store'
import { getCmsDataRow, getCmsPublishStatus, publishCmsDraft } from '@core/persistence'
import { LoaderIcon } from 'pixel-art-icons/icons/loader'
import { CalendarSolidIcon } from 'pixel-art-icons/icons/calendar-solid'
import { CheckIcon } from 'pixel-art-icons/icons/check'
import { CircleAlertSolidIcon } from 'pixel-art-icons/icons/circle-alert-solid'
import { CloudUploadSolidIcon } from 'pixel-art-icons/icons/cloud-upload-solid'
import { EyeSolidIcon } from 'pixel-art-icons/icons/eye-solid'
import { StepUpCancelledMessage, useStepUp } from '@admin/shared/StepUp'
import { SchedulePublishDialog } from '@admin/modals/SchedulePublishDialog'
import type { PersistenceSaveStatus } from '@site/hooks/usePersistence'
import { pushToast } from '@ui/components/Toast'
import { PublishActionGroup, type PublishActionMenuItem } from './PublishActionGroup'
import { getErrorMessage } from '@core/utils/errorMessage'
import { notifyCmsPublicationChanged } from '@admin/state/adminEvents'
import type { SiteRuntimeDiagnostic } from '@core/site-runtime'

type PublishState = 'idle' | 'publishing' | 'published' | 'error'

interface PublishButtonProps {
  enabled?: boolean
  saveStatus?: PersistenceSaveStatus
  runtimeDiagnostics?: SiteRuntimeDiagnostic[]
  runtimeValidationPending?: boolean
}

const EMPTY_RUNTIME_DIAGNOSTICS: SiteRuntimeDiagnostic[] = []

export function PublishButton({
  enabled = true,
  saveStatus,
  runtimeDiagnostics = EMPTY_RUNTIME_DIAGNOSTICS,
  runtimeValidationPending = false,
}: PublishButtonProps) {
  const site = useEditorStore((s) => s.site)
  const activeLocaleId = useEditorStore((s) => s.activeLocaleId)
  const setActiveLocaleId = useEditorStore((s) => s.setActiveLocaleId)
  const [publicationDialogOpen, setPublicationDialogOpen] = useState(false)
  const [languagesOpen, setLanguagesOpen] = useState(false)
  const currentUser = useCurrentAdminUser()
  const siteId = useEditorStore((s) => s.site?.id ?? null)
  const activePage = useEditorStore(selectActivePage)
  const openPreview = useEditorStore((s) => s.openPreview)
  const { runStepUp } = useStepUp()
  const [state, setState] = useState<PublishState>('idle')
  const [scheduleTarget, setScheduleTarget] = useState<{ rowId: string; localeId: string; scheduledAt: string | null } | null>(null)
  const [scheduleLoading, setScheduleLoading] = useState(false)
  const scheduleRequestRef = useRef(0)
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /**
   * The `site` reference captured when the button entered the "published"
   * state. Every store mutation (local or a remote peer's) produces a new
   * reference, so `site !== publishedSiteRef.current` is the exact "the
   * draft moved on since publish" signal that returns the button to idle.
   */
  const publishedSiteRef = useRef<SiteDocument | null>(null)
  const syncError = saveStatus?.state === 'error' ? saveStatus.message ?? 'Sync failed' : null
  const runtimeErrorCount = runtimeDiagnostics.filter((diagnostic) => diagnostic.severity === 'error').length
  const runtimeErrorLabel = `${runtimeErrorCount} code error${runtimeErrorCount === 1 ? '' : 's'}`

  useEffect(() => {
    const timer = statusTimerRef
    return () => {
      if (timer.current) clearTimeout(timer.current)
      scheduleRequestRef.current += 1
    }
  }, [])

  useEffect(() => {
    if (!enabled || !siteId) return
    let cancelled = false

    async function loadPublishStatus() {
      try {
        const status = await getCmsPublishStatus(undefined, undefined, activeLocaleId ?? undefined)
        if (cancelled) return
        if (status.draftMatchesPublished) {
          publishedSiteRef.current = useEditorStore.getState().site
          setState('published')
        }
      } catch (err) {
        console.warn('[toolbar] Failed to load publish status:', err)
      }
    }

    void loadPublishStatus()
    return () => { cancelled = true }
  }, [enabled, siteId, activeLocaleId])

  useEffect(() => {
    if (state !== 'published' || site === publishedSiteRef.current) return
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current)
    statusTimerRef.current = null
    const resetTimer = setTimeout(() => {
      setState('idle')
    }, 0)
    return () => clearTimeout(resetTimer)
  }, [site, state])

  const resetErrorLater = () => {
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current)
    statusTimerRef.current = setTimeout(() => {
      setState('idle')
      statusTimerRef.current = null
    }, 5000)
  }

  const handlePublish = async (selection: PublishVariantSelection): Promise<boolean> => {
    if (
      !site ||
      !enabled ||
      state === 'publishing' ||
      runtimeErrorCount > 0 ||
      runtimeValidationPending
    ) return false

    if (statusTimerRef.current) {
      clearTimeout(statusTimerRef.current)
      statusTimerRef.current = null
    }

    setState('publishing')

    try {
      // No client-side flush needed: edits stream to the server live, and
      // the publish endpoint flushes the relay's debounced persist itself.
      // Wrap the publish call in `runStepUp` so the StepUpProvider can
      // intercept the server's `step_up_required` 401, prompt the user
      // to re-enter their password, then retry. Publish is the highest-
      // publication action (it updates the selected language variants),
      // which is why the server gates it behind a fresh step-up window
      // in addition to the `pages.publish` capability check.
      await runStepUp(() => publishCmsDraft(undefined, undefined, selection))
      notifyCmsPublicationChanged()
      publishedSiteRef.current = useEditorStore.getState().site
      setState('published')
      return true
    } catch (err) {
      if (err instanceof Error && err.message === StepUpCancelledMessage) {
        // User dismissed the step-up dialog — return the button to its
        // resting state without surfacing an error message; this is the
        // same UX every other step-up-gated action uses.
        setState('idle')
        return false
      }
      console.error('[toolbar] Publish failed:', err)
      setState('error')
      pushToast({
        kind: 'error',
        title: 'Publish failed',
        body: getErrorMessage(err, 'Unknown publish error'),
        location: 'site-editor',
      })
      resetErrorLater()
      return false
    }
  }

  const isPublishing = state === 'publishing'
  // Block publish until the client is synced: local edits live only in this
  // client's Y docs until they reach the server, and the server-side publish
  // flush can only bake what it has received. Offline/connecting/error → the
  // status chip states the reason inline (never available-then-blocked). An
  // absent saveStatus (collab info unavailable) doesn't gate.
  const notSynced = saveStatus ? saveStatus.state !== 'synced' : false
  const disabled = (
    !site ||
    !enabled ||
    isPublishing ||
    notSynced ||
    runtimeErrorCount > 0 ||
    runtimeValidationPending
  )
  const label =
    isPublishing ? 'Publishing' :
    state === 'published' ? 'Published' :
    state === 'error' ? 'Retry publish' :
    'Publish'

  const status =
    syncError ? {
      label: 'Sync failed',
      tone: 'danger' as const,
      ariaLabel: syncError,
    } :
    saveStatus?.state === 'offline' ? {
      label: 'Offline — reconnecting',
      tone: 'warning' as const,
    } :
    saveStatus?.state === 'connecting' || saveStatus?.state === 'loading' ? {
      label: 'Connecting',
      tone: 'neutral' as const,
    } :
    runtimeErrorCount > 0 ? {
      label: runtimeErrorLabel,
      tone: 'danger' as const,
      ariaLabel: `${runtimeErrorLabel}. Resolve the highlighted script errors before publishing.`,
    } :
    runtimeValidationPending ? {
      label: 'Checking code',
      tone: 'neutral' as const,
      ariaLabel: 'Checking runtime scripts before publishing.',
    } :
    {
      label: 'Draft synced',
      tone: 'success' as const,
    }

  const PublishIcon =
    isPublishing ? LoaderIcon :
    state === 'published' ? CheckIcon :
    state === 'error' ? CircleAlertSolidIcon :
    CloudUploadSolidIcon

  async function openScheduleDialog() {
    const localeId = activeLocaleId ?? site?.localeId
    if (!activePage || !localeId || scheduleLoading) return
    const rowId = activePage.id
    const request = ++scheduleRequestRef.current
    setScheduleLoading(true)
    try {
      const row = await getCmsDataRow(rowId, undefined, undefined, localeId)
      const current = useEditorStore.getState()
      if (request === scheduleRequestRef.current && selectActivePage(current)?.id === rowId && (current.activeLocaleId ?? current.site?.localeId) === localeId) {
        if (!row) throw new Error('This page no longer exists')
        setScheduleTarget({ rowId, localeId, scheduledAt: row.scheduledPublishAt })
      }
    } catch (err) {
      if (request === scheduleRequestRef.current) {
        console.error('[toolbar] Failed to load publication schedule:', err)
        pushToast({ kind: 'error', title: 'Could not load publication schedule', body: getErrorMessage(err, 'Could not load schedule'), location: 'site-editor' })
      }
    }
    if (request === scheduleRequestRef.current) setScheduleLoading(false)
  }

  const menuItems: PublishActionMenuItem[] = [
    { id: 'translations', label: 'Page languages and publication…', icon: EyeSolidIcon,
      disabled: !activePage || notSynced, onSelect: () => setLanguagesOpen(true) },
    {
      // Per-page scheduling. The Site editor's primary Publish button
      // selects page-language variants explicitly;
      // the schedule action targets the currently-active page only —
      // matching what the user sees in the editor when they make the
      // decision.
      id: 'schedule-publish',
      label: 'Schedule publish…',
      icon: CalendarSolidIcon,
      disabled: !activePage || notSynced || scheduleLoading || runtimeErrorCount > 0 || runtimeValidationPending,
      onSelect: () => { void openScheduleDialog() },
      testId: 'toolbar-schedule-publish-action',
    },
    {
      id: 'preview',
      label: 'Preview page',
      icon: EyeSolidIcon,
      disabled: !site,
      onSelect: () => openPreview(),
      testId: 'toolbar-preview-action',
    },
    // "Open live page" used to live here. It now has a dedicated
    // toolbar icon button (`OpenLivePageButton`) next to the avatar so
    // it's reachable on every admin route — not just the Site editor.
  ]

  return (
    <>
      {site?.locales && <Select aria-label="Site language" fieldSize="sm" value={activeLocaleId ?? site.localeId ?? ''}
        disabled={isPublishing} options={site.locales.map((locale) => ({ value: locale.id, label: `${locale.name}${locale.enabled ? '' : ' · Offline'}` }))}
        onChange={(event) => setActiveLocaleId(event.target.value)} />}
      {languagesOpen && activePage && activeLocaleId && <ContentLanguagesDialog
        rowId={activePage.id} localeId={activeLocaleId} canPublish={enabled}
        canEdit={hasCapability(currentUser, 'site.content.edit')}
        onClose={() => setLanguagesOpen(false)} onEditLanguage={setActiveLocaleId} />}
      {publicationDialogOpen && <SitePublishDialog busy={isPublishing} onClose={() => setPublicationDialogOpen(false)} onPublish={handlePublish} />}
      <PublishActionGroup
        statusLabel={state === 'published' ? null : status.label}
        statusTone={status.tone}
        statusAriaLabel={status.ariaLabel}
        publishLabel={label}
        publishAriaLabel={
          state === 'published'
            ? 'Published'
            : runtimeErrorCount > 0
              ? `Cannot publish: ${runtimeErrorLabel}`
              : 'Publish site'
        }
        publishTitle={
          state === 'published'
            ? 'Published'
            : runtimeErrorCount > 0
              ? `Resolve ${runtimeErrorLabel} before publishing`
              : 'Publish site'
        }
        publishState={state === 'publishing' ? 'busy' : state === 'published' ? 'success' : state}
        publishBusy={isPublishing}
        publishDisabled={disabled}
        publishIcon={PublishIcon}
        onPublish={() => setPublicationDialogOpen(true)}
        menuItems={menuItems}
      />
      {scheduleTarget && scheduleTarget.rowId === activePage?.id && scheduleTarget.localeId === (activeLocaleId ?? site?.localeId) && (
        <SchedulePublishDialog
          open
          onClose={() => setScheduleTarget(null)}
          rowId={scheduleTarget.rowId}
          localeId={scheduleTarget.localeId}
          currentScheduledAt={scheduleTarget.scheduledAt}
          entityLabel="page"
          onScheduled={() => notifyCmsPublicationChanged()}
        />
      )}
    </>
  )
}
