import { useEffect, useRef, useState } from 'react'
import type { SiteDocument } from '@core/page-tree'
import { selectActivePage, useEditorStore } from '@site/store/store'
import { getCmsPublishStatus, publishCmsDraft } from '@core/persistence'
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
  const siteId = useEditorStore((s) => s.site?.id ?? null)
  const activePage = useEditorStore(selectActivePage)
  const openPreview = useEditorStore((s) => s.openPreview)
  const { runStepUp } = useStepUp()
  const [state, setState] = useState<PublishState>('idle')
  const [scheduleDialogOpen, setScheduleDialogOpen] = useState(false)
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
    }
  }, [])

  useEffect(() => {
    if (!enabled || !siteId) return
    let cancelled = false

    async function loadPublishStatus() {
      try {
        const status = await getCmsPublishStatus()
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
  }, [enabled, siteId])

  // Re-confirm publish availability whenever a draft save completes. The
  // `hasUnsavedChanges` reset effect below catches manual edits (the flag stays
  // true long enough to be observed), but an MCP editor-bridge edit flushes the
  // save immediately (`flushEditorSave`), flipping the flag true→false within a
  // single tick — too fast for that effect to ever render with `true`, so the
  // button stayed stuck on "Published". Keying off the save's `lastSavedAt`
  // re-asks the server after every save (manual OR bridge), so bridge-driven
  // edits surface the Publish affordance without an editor reload.
  const lastSavedAt = saveStatus?.state === 'saved' ? saveStatus.lastSavedAt : undefined
  useEffect(() => {
    if (!enabled || !siteId || lastSavedAt === undefined) return
    let cancelled = false

    async function refreshAfterSave() {
      try {
        const status = await getCmsPublishStatus()
        if (cancelled) return
        setState((prev) => {
          if (prev === 'publishing') return prev // never interrupt an in-flight publish
          if (status.draftMatchesPublished) return 'published'
          return prev === 'published' ? 'idle' : prev // draft now differs → re-enable Publish
        })
      } catch (err) {
        console.warn('[toolbar] Failed to refresh publish status:', err)
      }
    }

    void refreshAfterSave()
    return () => { cancelled = true }
  }, [enabled, siteId, lastSavedAt])

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

  const handlePublish = async () => {
    if (
      !site ||
      !enabled ||
      state === 'publishing' ||
      runtimeErrorCount > 0 ||
      runtimeValidationPending
    ) return

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
      // blast-radius site action (one click replaces every public page),
      // which is why the server gates it behind a fresh step-up window
      // in addition to the `pages.publish` capability check.
      await runStepUp(() => publishCmsDraft())
      publishedSiteRef.current = useEditorStore.getState().site
      setState('published')
    } catch (err) {
      if (err instanceof Error && err.message === StepUpCancelledMessage) {
        // User dismissed the step-up dialog — return the button to its
        // resting state without surfacing an error message; this is the
        // same UX every other step-up-gated action uses.
        setState('idle')
        return
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

  const menuItems: PublishActionMenuItem[] = [
    {
      // Per-page scheduling. The Site editor's primary Publish button
      // still publishes ALL draft pages at once (existing behaviour);
      // the schedule action targets the currently-active page only —
      // matching what the user sees in the editor when they make the
      // decision.
      id: 'schedule-publish',
      label: 'Schedule publish…',
      icon: CalendarSolidIcon,
      disabled: !activePage || runtimeErrorCount > 0 || runtimeValidationPending,
      onSelect: () => setScheduleDialogOpen(true),
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
        publishDisabled={disabled || state === 'published'}
        publishIcon={PublishIcon}
        onPublish={handlePublish}
        menuItems={menuItems}
      />
      {activePage && (
        <SchedulePublishDialog
          open={scheduleDialogOpen}
          onClose={() => setScheduleDialogOpen(false)}
          rowId={activePage.id}
          // The editor's in-memory Page shape doesn't carry the row's
          // scheduledPublishAt — that lives on the CMS row, not in the
          // site document. Future enhancement: read it from a
          // useCmsPageStatus(activePage.id) hook so re-opening the
          // dialog pre-fills with the current schedule. For now we
          // start fresh on every open.
          currentScheduledAt={null}
          entityLabel="page"
          onScheduled={() => {
            // Re-fetch publish status so the toolbar can transition out
            // of "Draft saved" / "Unsaved" into the published state if
            // the row picked up. Cheap call — the same endpoint the
            // mount-time useEffect uses.
            void getCmsPublishStatus().catch(() => undefined)
          }}
        />
      )}
    </>
  )
}
