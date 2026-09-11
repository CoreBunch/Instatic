/**
 * ManageBranchesDialog — every branch in one list: open, rename inline,
 * delete, or create a new one. The chip's palette is for switching fast;
 * this is where housekeeping happens.
 */
import { useState, type FormEvent } from 'react'
import { CheckIcon } from 'pixel-art-icons/icons/check'
import { CircleDotSolidIcon } from 'pixel-art-icons/icons/circle-dot-solid'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import { EditSolidIcon } from 'pixel-art-icons/icons/edit-solid'
import { GitBranchSolidIcon } from 'pixel-art-icons/icons/git-branch-solid'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { TrashSolidIcon } from 'pixel-art-icons/icons/trash-solid'
import { MAIN_BRANCH_ID, canActOnBranch, slugifyBranchName, type SiteBranch } from '@core/branches'
import { getErrorMessage } from '@core/utils/errorMessage'
import {
  createBranch,
  renameBranch,
  switchBranch,
  useActiveBranch,
  useBranchStore,
  useBranches,
} from '@admin/state/branchStore'
import { hasCapability } from '@admin/access'
import { useCurrentAdminUser } from '@admin/sessionContext'
import { useAdminUi } from '@admin/state/adminUi'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import { Input } from '@ui/components/Input'
import { SearchBar } from '@ui/components/SearchBar'
import { TagPill } from '@ui/components/TagPill'
import { pushToast } from '@ui/components/Toast'
import { cn } from '@ui/cn'
import { branchAccentStyle } from './branchAccent'
import { describeUpdated } from './branchTime'
import { DeleteBranchDialog } from './DeleteBranchDialog'
import styles from './ManageBranchesDialog.module.css'

interface ManageBranchesDialogProps {
  open: boolean
  onClose: () => void
}

export function ManageBranchesDialog({ open, onClose }: ManageBranchesDialogProps) {
  const siteName = useAdminUi((state) => state.siteName)
  const user = useCurrentAdminUser()
  // Forking is its own capability; each row's rename/delete follows the
  // same rule the server gates, so nothing here is offered and then refused.
  const canCreate = hasCapability(user, 'site.branches.create')
  const branches = useBranches()
  const current = useActiveBranch()

  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  // The strip's "Rename…" opens the dialog straight into the current row.
  const initialRenamingId = useBranchStore.getState().manageRenamingId
  const [renamingId, setRenamingId] = useState<string | null>(initialRenamingId)
  const [renameDraft, setRenameDraft] = useState(
    () => branches.find((branch) => branch.id === initialRenamingId)?.name ?? '',
  )
  const [deleting, setDeleting] = useState<SiteBranch | null>(null)
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const visible = needle
    ? branches.filter((branch) => branch.name.toLowerCase().includes(needle) || branch.id.includes(needle))
    : branches

  const newSlug = slugifyBranchName(newName)
  const newSlugTaken = branches.some((branch) => branch.id === newSlug)

  function close(): void {
    setCreating(false)
    setNewName('')
    setRenamingId(null)
    onClose()
  }

  async function submitCreate(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (!newSlug || newSlugTaken || submitting) return
    setSubmitting(true)
    try {
      const branch = await createBranch({ name: newName.trim(), id: newSlug, fromBranchId: current.id })
      setCreating(false)
      setNewName('')
      pushToast({ kind: 'success', title: `Created ${branch.name}`, body: `You're now editing ${branch.name}.` })
    } catch (err) {
      console.error('[branches] create failed:', err)
      pushToast({ kind: 'error', title: 'Could not create branch', body: getErrorMessage(err, 'Unknown branch error') })
    } finally {
      setSubmitting(false)
    }
  }

  async function submitRename(event: FormEvent, branch: SiteBranch): Promise<void> {
    event.preventDefault()
    const name = renameDraft.trim()
    if (!name || name === branch.name) {
      setRenamingId(null)
      return
    }
    try {
      await renameBranch(branch.id, name)
      setRenamingId(null)
    } catch (err) {
      console.error('[branches] rename failed:', err)
      pushToast({ kind: 'error', title: 'Could not rename branch', body: getErrorMessage(err, 'Unknown branch error') })
    }
  }

  return (
    <>
      <Dialog
        open={open}
        onClose={close}
        title="Branches"
        eyebrow={siteName ?? undefined}
        size="lg"
        footer={(
          <>
            <Button
              variant="secondary"
              size="sm"
              type="button"
              disabled={creating || !canCreate}
              tooltip={canCreate ? undefined : 'Your role cannot create branches'}
              data-testid="branch-manage-new"
              onClick={() => setCreating(true)}
            >
              <PlusIcon size={12} aria-hidden="true" />
              <span>New branch</span>
            </Button>
            <Button variant="primary" size="sm" type="button" onClick={close}>
              Done
            </Button>
          </>
        )}
      >
        <SearchBar
          className={styles.search}
          value={query}
          onValueChange={setQuery}
          placeholder="Search branches…"
          aria-label="Search branches"
          data-testid="branch-manage-search"
        />
        <ul className={styles.list} aria-label="Branches" data-testid="branch-manage-list">
          {creating && (
            <li className={cn(styles.row, styles.rowCreate)}>
              <form className={styles.createForm} onSubmit={(event) => { void submitCreate(event) }}>
                <span className={styles.icon} aria-hidden="true">
                  <GitBranchSolidIcon size={12} />
                </span>
                <Input
                  autoFocus
                  value={newName}
                  onChange={(event) => setNewName(event.target.value)}
                  placeholder="new-branch-name"
                  fieldSize="xs"
                  monospace
                  invalid={newSlugTaken}
                  aria-label="New branch name"
                  data-testid="branch-manage-new-name"
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      // Consumed here: the dialog's own Escape (and any other
                      // document-level Escape) must not see it.
                      event.preventDefault()
                      event.stopPropagation()
                      setCreating(false)
                    }
                  }}
                />
                <span className={styles.createFrom}>
                  from <strong>{current.name}</strong>
                </span>
                <Button
                  variant="primary"
                  size="xs"
                  type="submit"
                  disabled={!newSlug || newSlugTaken}
                  busy={submitting}
                >
                  Create
                </Button>
                <Button variant="ghost" size="xs" type="button" onClick={() => setCreating(false)}>
                  Cancel
                </Button>
              </form>
            </li>
          )}

          {visible.length === 0 && (
            <li className={styles.empty} role="status">No branch matches.</li>
          )}
          {visible.map((branch) => {
            const isMain = branch.id === MAIN_BRANCH_ID
            const isCurrent = branch.id === current.id
            const renaming = renamingId === branch.id
            const updated = describeUpdated(branch.updatedAt)
            return (
              <li
                key={branch.id}
                className={cn(styles.row, isCurrent && styles.rowCurrent)}
                style={branchAccentStyle(branch)}
                data-testid={`branch-manage-row-${branch.id}`}
              >
                <span className={styles.icon} aria-hidden="true">
                  {isMain ? <CircleDotSolidIcon size={12} /> : <GitBranchSolidIcon size={12} />}
                </span>

                {renaming ? (
                  <form className={styles.renameForm} onSubmit={(event) => { void submitRename(event, branch) }}>
                    <Input
                      autoFocus
                      value={renameDraft}
                      onChange={(event) => setRenameDraft(event.target.value)}
                      fieldSize="xs"
                      aria-label={`Rename ${branch.name}`}
                      data-testid="branch-manage-rename-input"
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') {
                          event.preventDefault()
                          event.stopPropagation()
                          setRenamingId(null)
                        }
                      }}
                    />
                    <Button variant="primary" size="xs" type="submit" iconOnly aria-label="Save name">
                      <CheckIcon size={12} aria-hidden="true" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      type="button"
                      iconOnly
                      aria-label="Cancel rename"
                      onClick={() => setRenamingId(null)}
                    >
                      <CloseIcon size={12} aria-hidden="true" />
                    </Button>
                  </form>
                ) : (
                  <span className={styles.main}>
                    <span className={styles.name}>
                      {branch.name}
                      {branch.id !== branch.name && <code className={styles.id}>{branch.id}</code>}
                    </span>
                    <span className={styles.meta}>
                      {isMain
                        ? 'The live site'
                        : [`from ${branch.baseBranchId ?? MAIN_BRANCH_ID}`, updated].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                )}

                {!renaming && (
                  <span className={styles.actions}>
                    {isCurrent ? (
                      <TagPill label="Current" size="xs" className={styles.pill} />
                    ) : (
                      <Button
                        variant="secondary"
                        size="xs"
                        type="button"
                        data-testid={`branch-manage-open-${branch.id}`}
                        onClick={() => {
                          switchBranch(branch.id)
                          close()
                        }}
                      >
                        Open
                      </Button>
                    )}
                    {!isMain && (
                      <>
                        <Button
                          variant="ghost"
                          size="xs"
                          type="button"
                          iconOnly
                          disabled={!canActOnBranch(user, branch)}
                          aria-label={`Rename ${branch.name}`}
                          tooltip={canActOnBranch(user, branch) ? 'Rename' : 'Only its creator or a branch manager can rename this branch'}
                          data-testid={`branch-manage-rename-${branch.id}`}
                          onClick={() => {
                            setRenamingId(branch.id)
                            setRenameDraft(branch.name)
                          }}
                        >
                          <EditSolidIcon size={12} aria-hidden="true" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="xs"
                          type="button"
                          iconOnly
                          dangerHover
                          disabled={!canActOnBranch(user, branch)}
                          aria-label={`Delete ${branch.name}`}
                          tooltip={canActOnBranch(user, branch) ? 'Delete' : 'Only its creator or a branch manager can delete this branch'}
                          data-testid={`branch-manage-delete-${branch.id}`}
                          onClick={() => setDeleting(branch)}
                        >
                          <TrashSolidIcon size={12} aria-hidden="true" />
                        </Button>
                      </>
                    )}
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      </Dialog>

      {deleting && <DeleteBranchDialog branch={deleting} onClose={() => setDeleting(null)} />}
    </>
  )
}
