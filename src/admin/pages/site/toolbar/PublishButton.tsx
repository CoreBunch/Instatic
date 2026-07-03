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
import { PublishActionGroup, type PublishActionMenuItem } from './PublishActionGroup'
import { getErrorMessage } from '@core/utils/errorMessage'

type PublishState = 'idle' | 'publishing' | 'published' | 'error'

interface PublishButtonProps {
  enabled?: boolean
  saveStatus?: PersistenceSaveStatus
}

export function PublishButton({ enabled = true, saveStatus }: PublishButtonProps) {
  const site = useEditorStore((s) => s.site)
  const siteId = useEditorStore((s) => s.site?.id ?? null)
  const activePage = useEditorStore(selectActivePage)
  const openPreview = useEditorStore((s) => s.openPreview)
  const { runStepUp } = useStepUp()
  const [state, setState] = useState<PublishState>('idle')
  const [message, setMessage] = useState<string | null>(null)
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

  useEffect(() => {
    return () => {
      if (statusTimerRef.current) clearTimeout(statusTimerRef.current)
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
          setMessage(null)
        }
      } catch (err) {
        console.warn('[toolbar] Failed to load publish status:', err)
      }
    }

    void loadPublishStatus()
    return () => { cancelled = true }
  }, [enabled, siteId])

  useEffect(() => {
    if (state !== 'published' || site === publishedSiteRef.current) return
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current)
    statusTimerRef.current = null
    const resetTimer = setTimeout(() => {
      setState('idle')
      setMessage(null)
    }, 0)
    return () => clearTimeout(resetTimer)
  }, [site, state])

  const resetErrorLater = () => {
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current)
    statusTimerRef.current = setTimeout(() => {
      setState('idle')
      setMessage(null)
      statusTimerRef.current = null
    }, 5000)
  }

  const clearMessageLater = () => {
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current)
    statusTimerRef.current = setTimeout(() => {
      setMessage(null)
      statusTimerRef.current = null
    }, 5000)
  }

  const handlePublish = async () => {
    if (!site || !enabled || state === 'publishing') return

    if (statusTimerRef.current) {
      clearTimeout(statusTimerRef.current)
      statusTimerRef.current = null
    }

    setState('publishing')
    setMessage(null)

    try {
      // No client-side flush needed: edits stream to the server live, and
      // the publish endpoint flushes the relay's debounced persist itself.
      // Wrap the publish call in `runStepUp` so the StepUpProvider can
      // intercept the server's `step_up_required` 401, prompt the user
      // to re-enter their password, then retry. Publish is the highest-
      // blast-radius site action (one click replaces every public page),
      // which is why the server gates it behind a fresh step-up window
      // in addition to the `pages.publish` capability check.
      const result = await runStepUp(() => publishCmsDraft())
      publishedSiteRef.current = useEditorStore.getState().site
      setState('published')
      setMessage(
        result.publishedPages === 1
          ? '1 page published'
          : `${result.publishedPages} pages published`,
      )
      clearMessageLater()
    } catch (err) {
      if (err instanceof Error && err.message === StepUpCancelledMessage) {
        // User dismissed the step-up dialog — return the button to its
        // resting state without surfacing an error message; this is the
        // same UX every other step-up-gated action uses.
        setState('idle')
        setMessage(null)
        return
      }
      setState('error')
      setMessage(getErrorMessage(err, 'Unknown publish error'))
      resetErrorLater()
    }
  }

  const isPublishing = state === 'publishing'
  const disabled = !site || !enabled || isPublishing
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
      disabled: !activePage,
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
        publishAriaLabel={state === 'published' ? 'Published' : 'Publish site'}
        publishTitle={state === 'published' ? 'Published' : 'Publish site'}
        publishState={state === 'publishing' ? 'busy' : state === 'published' ? 'success' : state}
        publishBusy={isPublishing}
        publishDisabled={disabled || state === 'published'}
        publishIcon={PublishIcon}
        onPublish={handlePublish}
        menuItems={menuItems}
        toast={message ? {
          tone: state === 'error' ? 'alert' : 'status',
          message,
        } : null}
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
