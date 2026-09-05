/**
 * BranchChip — the toolbar entry point for branches.
 *
 * A compact chip next to the site brand (icon only on main, tinted name on a
 * branch) opens a palette: search first, then the current branch and the
 * others by recency. The palette's footer flips into an in-place creator so
 * a new branch is two keystrokes away without leaving the toolbar. Managing
 * (rename, delete) lives in a dialog behind "Manage branches…".
 */
import { Suspense, lazy, useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { CheckIcon } from 'pixel-art-icons/icons/check'
import { ChevronLeftIcon } from 'pixel-art-icons/icons/chevron-left'
import { CircleDotSolidIcon } from 'pixel-art-icons/icons/circle-dot-solid'
import { EditSolidIcon } from 'pixel-art-icons/icons/edit-solid'
import { GitBranchSolidIcon } from 'pixel-art-icons/icons/git-branch-solid'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { MAIN_BRANCH_ID, slugifyBranchName, type SiteBranch } from '@core/branches'
import { getErrorMessage } from '@core/utils/errorMessage'
import { hasCapability } from '@admin/access'
import { useCurrentAdminUser } from '@admin/sessionContext'
import {
  createBranch,
  refreshBranches,
  switchBranch,
  useActiveBranch,
  useBranchStore,
  useBranches,
} from '@admin/state/branchStore'
import { Button } from '@ui/components/Button'
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuSeparator,
  MenuSearchHeader,
} from '@ui/components/ContextMenu'
import { FormField } from '@ui/components/FormField'
import { Input } from '@ui/components/Input'
import { SegmentedControl } from '@ui/components/SegmentedControl'
import { TagPill } from '@ui/components/TagPill'
import { pushToast } from '@ui/components/Toast'
import { cn } from '@ui/cn'
import { branchAccentStyle } from './branchAccent'
import { describeUpdated } from './branchTime'
import styles from './BranchSwitcher.module.css'

const ManageBranchesDialog = lazy(() =>
  import('./ManageBranchesDialog').then((m) => ({ default: m.ManageBranchesDialog })),
)

function branchMeta(branch: SiteBranch): string {
  if (branch.id === MAIN_BRANCH_ID) return 'The live site'
  const updated = describeUpdated(branch.updatedAt)
  return updated ? `from ${branch.baseBranchId ?? MAIN_BRANCH_ID} · ${updated}` : `from ${branch.baseBranchId ?? MAIN_BRANCH_ID}`
}

function BranchRow({
  branch,
  current,
  onSelect,
}: {
  branch: SiteBranch
  current: boolean
  onSelect: () => void
}) {
  const isMain = branch.id === MAIN_BRANCH_ID
  return (
    <ContextMenuItem
      className={cn(styles.row, current && styles.rowCurrent)}
      style={branchAccentStyle(branch)}
      aria-current={current ? 'true' : undefined}
      data-testid={`branch-row-${branch.id}`}
      onClick={onSelect}
    >
      <span className={styles.rowIcon} aria-hidden="true">
        {isMain ? <CircleDotSolidIcon size={12} /> : <GitBranchSolidIcon size={12} />}
      </span>
      <span className={styles.rowMain}>
        <span className={styles.rowName}>{branch.name}</span>
        <span className={styles.rowMeta}>{branchMeta(branch)}</span>
      </span>
      {/* Not an aria-hidden span itself: the menu sizes those as 16px icon slots. */}
      <span className={styles.rowTrailing}>
        {isMain && <TagPill label="Live" size="sm" className={styles.pill} aria-hidden="true" />}
        {current && <CheckIcon size={12} aria-hidden="true" />}
      </span>
    </ContextMenuItem>
  )
}

export function BranchChip() {
  const user = useCurrentAdminUser()
  const canCreate = hasCapability(user, 'site.branches.create')
  const branches = useBranches()
  const current = useActiveBranch()
  const mode = useBranchStore((state) => state.switcher)
  const openSwitcher = useBranchStore((state) => state.openSwitcher)
  const closeSwitcher = useBranchStore((state) => state.closeSwitcher)
  const manageOpen = useBranchStore((state) => state.manageOpen)
  const openManage = useBranchStore((state) => state.openManage)
  const closeManage = useBranchStore((state) => state.closeManage)

  const [query, setQuery] = useState('')
  const chipRef = useRef<HTMLButtonElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const menuId = useId()
  const currentHeadingId = `${menuId}-current`
  const recentHeadingId = `${menuId}-recent`

  const open = mode !== 'closed'
  const onMain = current.id === MAIN_BRANCH_ID

  useEffect(() => {
    const controller = new AbortController()
    refreshBranches(controller.signal).catch((err: unknown) => {
      if (controller.signal.aborted) return
      console.error('[branches] failed to load branches:', err)
    })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (!open) return
    refreshBranches().catch((err: unknown) => {
      console.error('[branches] failed to refresh branches:', err)
    })
  }, [open])

  useEffect(() => {
    if (open && mode === 'list') searchRef.current?.focus()
  }, [open, mode])

  const needle = query.trim().toLowerCase()
  const filtered = branches.filter(
    (branch) => branch.name.toLowerCase().includes(needle) || branch.id.includes(needle),
  )
  const others = branches.filter((branch) => branch.id !== current.id)

  function close(): void {
    closeSwitcher()
    setQuery('')
    // Unmounting the focused search field drops focus to <body>. Hand it
    // back to the chip — unless the dismissing click already moved it
    // elsewhere, or a switch is remounting the toolbar around the chip.
    const chip = chipRef.current
    setTimeout(() => {
      if (document.activeElement === document.body && chip?.isConnected) chip.focus()
    }, 0)
  }

  function select(branch: SiteBranch): void {
    switchBranch(branch.id)
    close()
  }

  function startCreate(): void {
    openSwitcher('create')
  }

  function onSearchKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key !== 'Enter') return
    event.preventDefault()
    const first = filtered[0]
    if (first) select(first)
    else if (canCreate && slugifyBranchName(query)) startCreate()
  }

  return (
    <>
      <Button
        ref={chipRef}
        variant="ghost"
        size="xs"
        type="button"
        iconOnly
        aria-label={onMain ? 'Branches' : `Branch . Switch branch`}
        aria-haspopup={mode === 'create' ? 'dialog' : 'menu'}
        aria-expanded={open}
        active={open}
        className={cn(styles.chip, !onMain && styles.chipBranch)}
        style={branchAccentStyle(current)}
        tooltip={onMain ? 'Branches' : `On  — switch branch`}
        tooltipSide="bottom"
        data-testid="branch-chip"
        onClick={() => (open ? close() : openSwitcher('list'))}
      >
        <GitBranchSolidIcon size={12} aria-hidden="true" />
      </Button>

      {open && createPortal(
        <ContextMenu
          id={menuId}
          // The creator is a small form, not a list of commands.
          role={mode === 'create' ? 'dialog' : 'menu'}
          ariaLabel={mode === 'create' ? 'Create branch' : 'Branches'}
          onClose={close}
          anchorRef={chipRef}
          side="bottom"
          align="start"
          width={360}
          maxHeight={480}
          zIndex={10000}
          header={mode === 'list' ? (
            <MenuSearchHeader
              value={query}
              onValueChange={setQuery}
              onKeyDown={onSearchKeyDown}
              placeholder="Search branches…"
              inputRef={searchRef}
              controls={menuId}
            />
          ) : undefined}
        >
          {mode === 'list' ? (
            <>
              {needle ? (
                <>
                  {filtered.map((branch) => (
                    <BranchRow
                      key={branch.id}
                      branch={branch}
                      current={branch.id === current.id}
                      onSelect={() => select(branch)}
                    />
                  ))}
                  {filtered.length === 0 && (canCreate && slugifyBranchName(query) ? (
                    <ContextMenuItem className={styles.createRow} onClick={startCreate}>
                      <PlusIcon size={12} aria-hidden="true" />
                      <span>
                        Create <code className={styles.code}>{slugifyBranchName(query)}</code>…
                      </span>
                    </ContextMenuItem>
                  ) : (
                    <div className={styles.empty} role="presentation">No branch matches.</div>
                  ))}
                </>
              ) : (
                <>
                  <div role="group" aria-labelledby={currentHeadingId}>
                    <div className={styles.group} id={currentHeadingId} role="presentation">Current</div>
                    <BranchRow branch={current} current onSelect={close} />
                  </div>
                  {others.length > 0 && (
                    <div role="group" aria-labelledby={recentHeadingId}>
                      <div className={styles.group} id={recentHeadingId} role="presentation">Recent</div>
                      {others.map((branch) => (
                        <BranchRow
                          key={branch.id}
                          branch={branch}
                          current={false}
                          onSelect={() => select(branch)}
                        />
                      ))}
                    </div>
                  )}
                </>
              )}
              {canCreate && (
                <>
                  <ContextMenuSeparator />
                  <ContextMenuItem data-testid="branch-create-action" onClick={startCreate}>
                    <PlusIcon size={12} aria-hidden="true" />
                    <span>Create branch…</span>
                  </ContextMenuItem>
                  <ContextMenuItem
                    data-testid="branch-manage-action"
                    onClick={() => {
                      close()
                      openManage()
                    }}
                  >
                    <EditSolidIcon size={12} aria-hidden="true" />
                    <span>Manage branches…</span>
                  </ContextMenuItem>
                </>
              )}
            </>
          ) : (
            <CreateBranchForm
              current={current}
              branches={branches}
              initialName={query.trim()}
              onBack={() => openSwitcher('list')}
              onCancel={close}
              onCreated={close}
            />
          )}
        </ContextMenu>,
        document.body,
      )}

      {manageOpen && (
        <Suspense fallback={null}>
          <ManageBranchesDialog open onClose={closeManage} />
        </Suspense>
      )}
    </>
  )
}

interface CreateBranchFormProps {
  current: SiteBranch
  branches: SiteBranch[]
  /** Seeded from the palette search so "Create <typed name>…" keeps the text. */
  initialName: string
  onBack: () => void
  onCancel: () => void
  onCreated: () => void
}

/**
 * The in-place creator. Mounted only while the palette is in create mode,
 * so every open starts fresh: the name from the search (if any), and the
 * branch the user is on as the default base — whichever way the mode was
 * entered (chip, palette row, or the Spotlight command).
 */
function CreateBranchForm({ current, branches, initialName, onBack, onCancel, onCreated }: CreateBranchFormProps) {
  const [name, setName] = useState(initialName)
  const [from, setFrom] = useState(current.id)
  const [creating, setCreating] = useState(false)
  const onMain = current.id === MAIN_BRANCH_ID
  const slug = slugifyBranchName(name)
  const duplicate = branches.some((branch) => branch.id === slug)
  const fromOptions = [
    { value: MAIN_BRANCH_ID, label: 'main' },
    ...(onMain ? [] : [{ value: current.id, label: current.name }]),
  ]

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (!slug || duplicate || creating) return
    setCreating(true)
    try {
      const branch = await createBranch({ name: name.trim(), id: slug, fromBranchId: from })
      onCreated()
      pushToast({
        kind: 'success',
        title: `Created ${branch.name}`,
        body: `You're now editing ${branch.name}. Everything on it stays private until you merge it.`,
      })
    } catch (err) {
      console.error('[branches] create failed:', err)
      pushToast({ kind: 'error', title: 'Could not create branch', body: getErrorMessage(err, 'Unknown branch error') })
    } finally {
      setCreating(false)
    }
  }

  return (
    <form className={styles.createForm} onSubmit={submit} data-testid="branch-create-form">
      <div className={styles.createHeader}>
        <Button variant="ghost" size="xs" type="button" iconOnly aria-label="Back to branches" onClick={onBack}>
          <ChevronLeftIcon size={12} aria-hidden="true" />
        </Button>
        <span className={styles.createTitle}>Create branch</span>
      </div>
      <FormField label="Name" htmlFor="branch-create-name">
        <Input
          id="branch-create-name"
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="spring-redesign"
          fieldSize="sm"
          monospace
          invalid={duplicate}
          data-testid="branch-create-name"
        />
      </FormField>
      <p className={cn(styles.hint, duplicate && styles.hintError)} role={duplicate ? 'alert' : undefined}>
        {duplicate
          ? `A branch called ${slug} already exists.`
          : slug && slug !== name.trim()
            ? `Will be created as ${slug}`
            : 'Everything on the branch stays private until you merge it.'}
      </p>
      <FormField label="Start from">
        {fromOptions.length > 1 ? (
          <SegmentedControl
            value={from}
            options={fromOptions}
            onChange={setFrom}
            size="xs"
            fullWidth
            aria-label="Start from"
          />
        ) : (
          <span className={styles.fromMain}>main, the live site</span>
        )}
      </FormField>
      <div className={styles.createActions}>
        <Button variant="ghost" size="xs" type="button" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="xs"
          type="submit"
          disabled={!slug || duplicate}
          busy={creating}
          data-testid="branch-create-submit"
        >
          Create branch
        </Button>
      </div>
    </form>
  )
}
