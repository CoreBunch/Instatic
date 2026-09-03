/**
 * BranchContextStrip — the band above the toolbar while a branch is active.
 *
 * Painted in the workspace surface colour so it reads as part of the canvas
 * rather than the toolbar chrome; the branch's identity tint lands on the
 * icon and name only. Carries the branch's own actions — everything that is
 * ABOUT the branch rather than about the page — and disappears on main.
 */
import { Suspense, lazy, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from '@admin/lib/routing'
import { ArrowDownIcon } from 'pixel-art-icons/icons/arrow-down'
import { CircleDotSolidIcon } from 'pixel-art-icons/icons/circle-dot-solid'
import { EditSolidIcon } from 'pixel-art-icons/icons/edit-solid'
import { EyeOffSolidIcon } from 'pixel-art-icons/icons/eye-off-solid'
import { GitBranchSolidIcon } from 'pixel-art-icons/icons/git-branch-solid'
import { GitMergeSolidIcon } from 'pixel-art-icons/icons/git-merge-solid'
import { LinkIcon } from 'pixel-art-icons/icons/link'
import { MoreHorizontalSolidIcon } from 'pixel-art-icons/icons/more-horizontal-solid'
import { ShareSolidIcon } from 'pixel-art-icons/icons/share-solid'
import { TrashSolidIcon } from 'pixel-art-icons/icons/trash-solid'
import { MAIN_BRANCH_ID, type BranchPreview, type MergeDirection, type SiteBranch } from '@core/branches'
import { getCmsBranchPreview, issueCmsBranchPreview, revokeCmsBranchPreview } from '@core/persistence'
import { isAbortError } from '@core/http'
import { getErrorMessage } from '@core/utils/errorMessage'
import { hasCapability } from '@admin/access'
import { useCurrentAdminUser } from '@admin/sessionContext'
import { switchBranch, useActiveBranch, useBranchStore } from '@admin/state/branchStore'
import { Button } from '@ui/components/Button'
import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from '@ui/components/ContextMenu'
import { pushToast } from '@ui/components/Toast'
import { branchAccentStyle } from './branchAccent'
import { describeUpdated } from './branchTime'
import styles from './BranchSwitcher.module.css'

const DeleteBranchDialog = lazy(() =>
  import('./DeleteBranchDialog').then((m) => ({ default: m.DeleteBranchDialog })),
)
const MergeBranchDialog = lazy(() =>
  import('./MergeBranchDialog').then((m) => ({ default: m.MergeBranchDialog })),
)

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Clipboard access is blocked in some contexts; the URL still reaches
    // the user through the toast body.
    return false
  }
}

export function BranchContextStrip() {
  const current = useActiveBranch()
  if (current.id === MAIN_BRANCH_ID) return null
  // Keyed by branch so every piece of per-branch state (preview link, open
  // menus, dialogs) starts fresh on a switch instead of being reset by hand.
  return <BranchStripBody key={current.id} branch={current} />
}

function BranchStripBody({ branch: current }: { branch: SiteBranch }) {
  const user = useCurrentAdminUser()
  const canManage = hasCapability(user, 'site.branches.manage')
  const navigate = useNavigate()
  const openManage = useBranchStore((state) => state.openManage)
  const [moreOpen, setMoreOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [preview, setPreview] = useState<BranchPreview | null>(null)
  const [sharing, setSharing] = useState(false)
  const [merge, setMerge] = useState<MergeDirection | null>(null)
  const moreRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const controller = new AbortController()
    getCmsBranchPreview(current.id)
      .then((state) => {
        if (!controller.signal.aborted) setPreview(state)
      })
      .catch((err: unknown) => {
        if (isAbortError(err) || controller.signal.aborted) return
        console.error('[branches] failed to load the preview link state:', err)
      })
    return () => controller.abort()
  }, [current.id])

  const updated = describeUpdated(current.updatedAt)
  const meta = [`from ${current.baseBranchId ?? MAIN_BRANCH_ID}`, updated].filter(Boolean).join(' · ')

  async function share(): Promise<void> {
    if (sharing) return
    setSharing(true)
    try {
      const issued = await issueCmsBranchPreview(current.id)
      setPreview(issued.preview)
      const copied = await copyToClipboard(issued.url)
      pushToast({
        kind: 'success',
        title: copied ? 'Preview link copied' : 'Preview link ready',
        body: preview
          ? `${issued.url} — the previous link no longer works.`
          : `${issued.url} — anyone with the link sees this branch's draft.`,
      })
    } catch (err) {
      console.error('[branches] share preview failed:', err)
      pushToast({ kind: 'error', title: 'Could not create the preview link', body: getErrorMessage(err, 'Unknown branch error') })
    } finally {
      setSharing(false)
    }
  }

  async function revoke(): Promise<void> {
    try {
      await revokeCmsBranchPreview(current.id)
      setPreview(null)
      pushToast({ kind: 'success', title: 'Preview link revoked', body: 'The shared link no longer opens this branch.' })
    } catch (err) {
      console.error('[branches] revoke preview failed:', err)
      pushToast({ kind: 'error', title: 'Could not revoke the preview link', body: getErrorMessage(err, 'Unknown branch error') })
    }
  }

  return (
    <div
      className={styles.strip}
      style={branchAccentStyle(current)}
      role="region"
      aria-label={`Branch ${current.name}`}
      data-testid="branch-strip"
    >
      <GitBranchSolidIcon size={12} aria-hidden="true" className={styles.stripIcon} />
      <span className={styles.stripName}>{current.name}</span>
      <span className={styles.stripMeta}>{meta}</span>
      {preview && (
        <span className={styles.stripLinked} title="A preview link is active" data-testid="branch-strip-preview-active">
          <LinkIcon size={12} aria-hidden="true" />
          <span>Preview link active</span>
        </span>
      )}
      <span className={styles.stripSpacer} aria-hidden="true" />

      {canManage && (
        <Button
          variant="secondary"
          size="xs"
          type="button"
          busy={sharing}
          tooltip={preview ? 'Issue a fresh link; the previous one stops working' : 'Anyone with the link sees this branch’s draft'}
          tooltipSide="bottom"
          data-testid="branch-strip-share"
          onClick={() => { void share() }}
        >
          <ShareSolidIcon size={12} aria-hidden="true" />
          <span>{preview ? 'New preview link' : 'Share preview'}</span>
        </Button>
      )}

      <Button
        variant="primary"
        size="xs"
        type="button"
        data-testid="branch-strip-merge"
        tooltip={canManage ? 'Review every change, then merge' : 'Review the changes and request a merge'}
        tooltipSide="bottom"
        onClick={() => navigate(`/admin/branches/${encodeURIComponent(current.id)}/review`)}
      >
        <GitMergeSolidIcon size={12} aria-hidden="true" />
        <span>{canManage ? 'Merge into main…' : 'Request merge…'}</span>
      </Button>

      <Button
        ref={moreRef}
        variant="ghost"
        size="xs"
        type="button"
        iconOnly
        aria-label="More branch actions"
        aria-haspopup="menu"
        aria-expanded={moreOpen}
        active={moreOpen}
        data-testid="branch-strip-more"
        onClick={() => setMoreOpen((value) => !value)}
      >
        <MoreHorizontalSolidIcon size={12} aria-hidden="true" />
      </Button>

      {moreOpen && createPortal(
        <ContextMenu
          ariaLabel="Branch actions"
          onClose={() => setMoreOpen(false)}
          anchorRef={moreRef}
          side="bottom"
          align="end"
          width={240}
          zIndex={10000}
        >
          {canManage && (
            <ContextMenuItem
              data-testid="branch-strip-update"
              onClick={() => {
                setMoreOpen(false)
                setMerge('update')
              }}
            >
              <ArrowDownIcon size={12} aria-hidden="true" />
              <span>Update from main…</span>
            </ContextMenuItem>
          )}
          {canManage && (
            <ContextMenuItem
              onClick={() => {
                setMoreOpen(false)
                openManage(current.id)
              }}
            >
              <EditSolidIcon size={12} aria-hidden="true" />
              <span>Rename…</span>
            </ContextMenuItem>
          )}
          {canManage && preview && (
            <ContextMenuItem
              data-testid="branch-strip-revoke"
              onClick={() => {
                setMoreOpen(false)
                void revoke()
              }}
            >
              <EyeOffSolidIcon size={12} aria-hidden="true" />
              <span>Revoke preview link</span>
            </ContextMenuItem>
          )}
          <ContextMenuItem
            data-testid="branch-strip-switch-main"
            onClick={() => {
              setMoreOpen(false)
              switchBranch(MAIN_BRANCH_ID)
            }}
          >
            <CircleDotSolidIcon size={12} aria-hidden="true" />
            <span>Switch to main</span>
          </ContextMenuItem>
          {canManage && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem
                danger
                data-testid="branch-strip-delete"
                onClick={() => {
                  setMoreOpen(false)
                  setDeleting(true)
                }}
              >
                <TrashSolidIcon size={12} aria-hidden="true" />
                <span>Delete branch</span>
              </ContextMenuItem>
            </>
          )}
        </ContextMenu>,
        document.body,
      )}

      {deleting && (
        <Suspense fallback={null}>
          <DeleteBranchDialog branch={current} onClose={() => setDeleting(false)} />
        </Suspense>
      )}
      {merge && (
        <Suspense fallback={null}>
          <MergeBranchDialog key={merge} branch={current} direction={merge} onClose={() => setMerge(null)} />
        </Suspense>
      )}
    </div>
  )
}
