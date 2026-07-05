import { useEffect, useRef, useState } from 'react'
import { selectActivePage, useEditorStore } from '@site/store/store'
import { getCmsPublishStatus, publishCmsDraft } from '@core/persistence'
import { LoaderIcon } from 'pixel-art-icons/icons/loader'
import { CalendarSolidIcon } from 'pixel-art-icons/icons/calendar-solid'
import { CheckIcon } from 'pixel-art-icons/icons/check'
import { CircleAlertSolidIcon } from 'pixel-art-icons/icons/circle-alert-solid'
import { CloudUploadSolidIcon } from 'pixel-art-icons/icons/cloud-upload-solid'
import { EyeSolidIcon } from 'pixel-art-icons/icons/eye-solid'
import { SaveSolidIcon } from 'pixel-art-icons/icons/save-solid'
import { StepUpCancelledMessage, useStepUp } from '@admin/shared/StepUp'
import { SchedulePublishDialog } from '@admin/modals/SchedulePublishDialog'
import type { PersistenceSaveStatus } from '@site/hooks/usePersistence'
import { PublishActionGroup, type PublishActionMenuItem } from './PublishActionGroup'
import { getErrorMessage } from '@core/utils/errorMessage'

type PublishState = 'idle' | 'publishing' | 'published' | 'error'

async function triggerManualSave(
  onSave: () => void | Promise<void>,
  setIsSaving: (v: boolean) => void,
): Promise<void> {
  setIsSaving(true)
  try {
    await onSave()
  } catch (err) {
    console.error('[toolbar] Manual save failed:', err)
  } finally {
    setIsSaving(false)
  }
}

interface PublishButtonProps {
  enabled?: boolean
  onSave?: () => void | Promise<void>
  saveStatus?: PersistenceSaveStatus
}

export function PublishButton({ enabled = true, onSave, saveStatus }: PublishButtonProps) {
  const site = useEditorStore((s) => s.site)
  const siteId = useEditorStore((s) => s.site?.id ?? null)
  const activePage = useEditorStore(selectActivePage)
  const openPreview = useEditorStore((s) => s.openPreview)
  const hasUnsavedChanges = useEditorStore((s) => s.hasUnsavedChanges)
  const { runStepUp } = useStepUp()
  const [state, setState] = useState<PublishState>('idle')
  const [message, setMessage] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [scheduleDialogOpen, setScheduleDialogOpen] = useState(false)
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isStatusSaving = saveStatus?.state === 'saving'
  const saveError = saveStatus?.state === 'error' ? saveStatus.message ?? 'Save failed' : null

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
    if (!hasUnsavedChanges || state !== 'published') return
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current)
    statusTimerRef.current = null
    const resetTimer = setTimeout(() => {
      setState('idle')
      setMessage(null)
    }, 0)
    return () => clearTimeout(resetTimer)
  }, [hasUnsavedChanges, state])

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
      await onSave?.()
      // Wrap the publish call in `runStepUp` so the StepUpProvider can
      // intercept the server's `step_up_required` 401, prompt the user
      // to re-enter their password, then retry. Publish is the highest-
      // blast-radius site action (one click replaces every public page),
      // which is why the server gates it behind a fresh step-up window
      // in addition to the `pages.publish` capability check.
      const result = await runStepUp(() => publishCmsDraft())
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

  const handleManualSave = async () => {
    if (!onSave || isSaving || isStatusSaving) return
    await triggerManualSave(onSave, setIsSaving)
  }

  const isPublishing = state === 'publishing'
  const disabled = !site || !enabled || isPublishing
  const label =
    isPublishing ? 'Publishing' :
    state === 'published' ? 'Published' :
    state === 'error' ? 'Retry publish' :
    'Publish'

  const status =
    saveError ? {
      label: 'Draft save failed',
      tone: 'danger' as const,
      ariaLabel: saveError,
    } :
    isStatusSaving || isSaving ? {
      label: 'Saving draft',
      tone: 'neutral' as const,
    } :
    hasUnsavedChanges ? {
      label: 'Unsaved draft',
      tone: 'warning' as const,
    } :
    {
      label: 'Draft saved',
      tone: 'success' as const,
    }

  const PublishIcon =
    isPublishing ? LoaderIcon :
    state === 'published' ? CheckIcon :
    state === 'error' ? CircleAlertSolidIcon :
    CloudUploadSolidIcon

  const menuItems: PublishActionMenuItem[] = [
    {
      id: 'save-draft',
      label: 'Save draft',
      icon: SaveSolidIcon,
      disabled: !onSave || isSaving || isStatusSaving,
      onSelect: handleManualSave,
      testId: 'toolbar-save-draft-action',
    },
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
