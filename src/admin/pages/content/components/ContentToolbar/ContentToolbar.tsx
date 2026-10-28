import { Suspense, lazy, useState } from 'react'
import { CalendarSolidIcon } from 'pixel-art-icons/icons/calendar-solid'
import { CheckIcon } from 'pixel-art-icons/icons/check'
import { CircleAlertSolidIcon } from 'pixel-art-icons/icons/circle-alert-solid'
import { ExternalLinkSolidIcon } from 'pixel-art-icons/icons/external-link-solid'
import { ArchiveRestoreSolidIcon } from 'pixel-art-icons/icons/archive-restore-solid'
import { LoaderIcon } from 'pixel-art-icons/icons/loader'
import { SaveSolidIcon } from 'pixel-art-icons/icons/save-solid'
import { SendSolidIcon } from 'pixel-art-icons/icons/send-solid'
import type { IconComponent } from 'pixel-art-icons/types'
import type { DataTable, DataRow } from '@core/data/schemas'
import {
  PublishActionGroup,
  type PublishActionMenuItem,
  type PublishActionStatusTone,
} from '@site/toolbar/PublishActionGroup'
import { SchedulePublishDialog } from '@admin/modals/SchedulePublishDialog'
import { useBranchPublishGate } from '@admin/state/branchStore'
import type { SaveMessage } from '@content/hooks/useContentEntryDraft'

interface ContentToolbarProps {
  contentLoading: boolean
  saveMessage: SaveMessage
  isDirty: boolean
  selectedEntry: DataRow | null
  selectedCollection: DataTable | null
  publicPath: string
  canSaveDraft: boolean
  canPublish: boolean
  onSaveDraft: () => void
  onPublish: () => void
  onSchedule: (entry: DataRow) => void
  /** Fires with the draft row after a published version is restored into it. */
  onRestored: (entry: DataRow) => void
}

// ---------------------------------------------------------------------------
// View-state derivation
//
// The toolbar's status / publish-button labels are pure derivations from the
// (loading, saveMessage, isDirty, selectedEntry, ...) tuple. Each helper
// below covers one observable: keeping each branch small + named makes the
// state machine readable without buying into a full reducer.
// ---------------------------------------------------------------------------

type PublishButtonState = 'idle' | 'busy' | 'success' | 'error'

// Opened rarely — loaded on first open so the content route chunk stays small.
const VersionHistoryDialog = lazy(() =>
  import('@admin/shared/VersionHistoryDialog').then((m) => ({ default: m.VersionHistoryDialog })),
)

interface ToolbarViewState {
  statusText: string
  statusTone: PublishActionStatusTone
  publishLabel: string
  PublishIcon: IconComponent
  publishState: PublishButtonState
  isCleanPublished: boolean
}

function isCleanPublishedEntry(
  selectedEntry: DataRow | null,
  isDirty: boolean,
  saveMessage: SaveMessage,
): boolean {
  if (selectedEntry?.status !== 'published') return false
  if (isDirty) return false
  return saveMessage !== 'saving' && saveMessage !== 'publishing' && saveMessage !== 'error'
}

function deriveStatusText(args: {
  contentLoading: boolean
  saveMessage: SaveMessage
  isDirty: boolean
  selectedEntry: DataRow | null
  isCleanPublished: boolean
}): string {
  const { contentLoading, saveMessage, isDirty, selectedEntry, isCleanPublished } = args
  if (contentLoading) return 'Loading content'
  if (saveMessage === 'publishing') return 'Publishing'
  if (saveMessage === 'saving') return 'Saving draft'
  if (saveMessage === 'error') return 'Save failed'
  if (isDirty) return 'Unsaved draft'
  if (selectedEntry?.status === 'scheduled') return 'Scheduled'
  if (saveMessage === 'saved') return 'Draft saved'
  if (isCleanPublished) return 'Published'
  if (selectedEntry?.status === 'unpublished') return 'Unpublished'
  if (selectedEntry) return 'Draft'
  return 'No entry selected'
}

function deriveStatusTone(args: {
  saveMessage: SaveMessage
  isDirty: boolean
  isCleanPublished: boolean
}): PublishActionStatusTone {
  const { saveMessage, isDirty, isCleanPublished } = args
  if (saveMessage === 'error') return 'danger'
  if (isDirty) return 'warning'
  if (saveMessage === 'saved' || isCleanPublished) return 'success'
  return 'neutral'
}

function derivePublishLabel(args: {
  saveMessage: SaveMessage
  isCleanPublished: boolean
}): string {
  const { saveMessage, isCleanPublished } = args
  if (saveMessage === 'publishing') return 'Publishing'
  if (isCleanPublished) return 'Published'
  if (saveMessage === 'error') return 'Retry publish'
  return 'Publish'
}

function derivePublishIcon(args: {
  saveMessage: SaveMessage
  isCleanPublished: boolean
}): IconComponent {
  const { saveMessage, isCleanPublished } = args
  // Kept as a flat ternary chain (rather than early-return ifs) so the
  // architecture gate at contentAdmin.test.tsx:1672 can detect the
  // `isCleanPublished ? CheckIcon` proof-of-shape.
  return saveMessage === 'publishing' ? LoaderIcon
    : isCleanPublished ? CheckIcon
    : saveMessage === 'error' ? CircleAlertSolidIcon
    : SendSolidIcon
}

function derivePublishState(args: {
  saveMessage: SaveMessage
  isCleanPublished: boolean
}): PublishButtonState {
  const { saveMessage, isCleanPublished } = args
  if (saveMessage === 'publishing') return 'busy'
  if (saveMessage === 'error') return 'error'
  if (isCleanPublished) return 'success'
  return 'idle'
}

function deriveToolbarViewState(args: {
  contentLoading: boolean
  saveMessage: SaveMessage
  isDirty: boolean
  selectedEntry: DataRow | null
}): ToolbarViewState {
  const { contentLoading, saveMessage, isDirty, selectedEntry } = args
  const isCleanPublished = isCleanPublishedEntry(selectedEntry, isDirty, saveMessage)
  return {
    statusText: deriveStatusText({ contentLoading, saveMessage, isDirty, selectedEntry, isCleanPublished }),
    statusTone: deriveStatusTone({ saveMessage, isDirty, isCleanPublished }),
    publishLabel: derivePublishLabel({ saveMessage, isCleanPublished }),
    PublishIcon: derivePublishIcon({ saveMessage, isCleanPublished }),
    publishState: derivePublishState({ saveMessage, isCleanPublished }),
    isCleanPublished,
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ContentToolbar({
  contentLoading,
  saveMessage,
  isDirty,
  selectedEntry,
  selectedCollection,
  publicPath,
  canSaveDraft,
  canPublish,
  onSaveDraft,
  onPublish,
  onSchedule,
  onRestored,
}: ContentToolbarProps) {
  const entryLabel = (selectedCollection?.singularLabel ?? 'entry').toLowerCase()
  // Destructure the derived view state so the JSX below keeps reading like
  // a flat list of locals — the architecture gate at
  // contentAdmin.test.tsx:1664 also relies on literal `isCleanPublished` /
  // `statusText` references in this file as proof-of-shape.
  const { statusText, statusTone, publishLabel, PublishIcon, publishState, isCleanPublished } =
    deriveToolbarViewState({ contentLoading, saveMessage, isDirty, selectedEntry })

  const isSaving = saveMessage === 'saving'
  const isPublishing = saveMessage === 'publishing'
  const [scheduleDialogOpen, setScheduleDialogOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  // Publishing and scheduling only exist on main — disabled with the reason
  // inline while a branch is active.
  const branchGate = useBranchPublishGate()

  const menuItems: PublishActionMenuItem[] = [
    {
      id: 'save-draft',
      label: 'Save draft',
      icon: SaveSolidIcon,
      disabled: !selectedEntry || !canSaveDraft || isSaving || !isDirty,
      onSelect: onSaveDraft,
      testId: 'toolbar-content-save-draft-action',
    },
    {
      // Schedule the selected entry for future publication. Disabled
      // when there's no entry or the user lacks publish capability —
      // mirrors the publish button's own gate.
      id: 'schedule-publish',
      label: `Schedule ${entryLabel}…`,
      icon: CalendarSolidIcon,
      disabled: !selectedEntry || !canPublish || isPublishing || branchGate.onBranch,
      onSelect: () => setScheduleDialogOpen(true),
      testId: 'toolbar-content-schedule-publish-action',
    },
    {
      id: 'version-history',
      label: 'Version history…',
      icon: ArchiveRestoreSolidIcon,
      disabled: !selectedEntry || !canSaveDraft,
      onSelect: () => setHistoryOpen(true),
      testId: 'toolbar-content-version-history-action',
    },
    {
      id: 'open-live',
      label: `Open live ${entryLabel}`,
      icon: ExternalLinkSolidIcon,
      disabled: !publicPath,
      onSelect: () => {
        if (!publicPath) return
        window.open(publicPath, '_blank', 'noopener,noreferrer')
      },
      testId: 'toolbar-content-open-entry-action',
    },
  ]

  return (
    <>
      <PublishActionGroup
        statusLabel={isCleanPublished ? null : statusText}
        statusTone={statusTone}
        publishLabel={publishLabel}
        publishAriaLabel={
          branchGate.reason
            ? `Cannot publish: ${branchGate.reason}`
            : isCleanPublished ? 'Published' : `Publish ${entryLabel}`
        }
        publishTitle={branchGate.reason ?? (isCleanPublished ? 'Published' : `Publish ${entryLabel}`)}
        publishState={publishState}
        publishBusy={isPublishing}
        publishDisabled={!selectedEntry || !canPublish || isPublishing || isCleanPublished || branchGate.onBranch}
        publishIcon={PublishIcon}
        onPublish={onPublish}
        menuItems={menuItems}
      />
      {selectedEntry && historyOpen && (
        <Suspense fallback={null}>
          <VersionHistoryDialog
            rowId={selectedEntry.id}
            entityLabel={entryLabel}
            title={typeof selectedEntry.cells.title === 'string' ? selectedEntry.cells.title : null}
            onClose={() => setHistoryOpen(false)}
            onRestored={onRestored}
          />
        </Suspense>
      )}
      {selectedEntry && (
        <SchedulePublishDialog
          open={scheduleDialogOpen}
          onClose={() => setScheduleDialogOpen(false)}
          rowId={selectedEntry.id}
          currentScheduledAt={selectedEntry.scheduledPublishAt}
          entityLabel={entryLabel}
          onScheduled={onSchedule}
        />
      )}
    </>
  )
}
