/**
 * Active branch — which site branch this tab is editing, plus the branch
 * registry and the switcher's UI state.
 *
 * Every admin request carries the branch as the `X-Instatic-Branch` header
 * (registered as an ambient header provider at boot), every collab doc id
 * minted by the editor carries it, and the branch-scoped workspaces (Site,
 * Content, Data) remount when it changes so their data reloads.
 *
 * The active id itself is owned by `activeBranch.ts` (installed at boot so
 * the very first request carries the header); this store mirrors it for
 * React and adds the registry and UI state on top.
 *
 * Publishing and scheduling only exist on main. `useBranchPublishGate` is
 * the one place every publish control asks "am I on a branch, and what do
 * I tell the user" — the controls disable with that reason inline instead
 * of letting a click reach the server's 409.
 */
import { create } from 'zustand'
import {
  MAIN_BRANCH_ID,
  type ApplyMergeBody,
  type CreateBranchBody,
  type MergeDirection,
  type SiteBranch,
  type ApplyMergeEnvelope,
  type UndoMergeEnvelope,
} from '@core/branches'
import { registerApiErrorListener } from '@core/http'
import {
  applyCmsBranchMerge,
  createCmsBranch,
  deleteCmsBranch,
  listCmsBranches,
  renameCmsBranch,
  undoCmsBranchMerge,
} from '@core/persistence'
import { pushToast } from '@ui/components/Toast'
import { BRANCH_HEADER, currentBranchId, rememberBranchId } from './activeBranch'

const BRANCH_NOT_FOUND_CODE = 'branch_not_found'

/** The inline reason every publish/schedule control shows on a branch. */
export const BRANCH_PUBLISH_REASON = 'Publishing happens on main. Merge this branch first.'

export type BranchSwitcherMode = 'closed' | 'list' | 'create'

interface BranchState {
  activeBranchId: string
  /** The registry, main first then most recently updated. */
  branches: SiteBranch[]
  /** False until the first successful registry load. */
  branchesLoaded: boolean
  switcher: BranchSwitcherMode
  manageOpen: boolean
  /** Branch to start renaming when the manage dialog opens. */
  manageRenamingId: string | null
  /**
   * Bumped when a merge or update rewrote the active branch's content in
   * place; the branch-scoped workspaces key on it so they reload.
   */
  epoch: number
  setActiveBranch: (branchId: string) => void
  setBranches: (branches: SiteBranch[]) => void
  openSwitcher: (mode?: Exclude<BranchSwitcherMode, 'closed'>) => void
  closeSwitcher: () => void
  openManage: (renamingId?: string) => void
  closeManage: () => void
  bumpEpoch: () => void
}

/** Main first, then most recently updated. */
export function sortBranches(branches: readonly SiteBranch[]): SiteBranch[] {
  return [...branches].sort((a, b) => {
    if (a.id === MAIN_BRANCH_ID) return -1
    if (b.id === MAIN_BRANCH_ID) return 1
    return Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
  })
}

export const useBranchStore = create<BranchState>((set) => ({
  activeBranchId: currentBranchId(),
  branches: [],
  branchesLoaded: false,
  switcher: 'closed',
  manageOpen: false,
  manageRenamingId: null,
  epoch: 0,
  setActiveBranch: (branchId) => {
    rememberBranchId(branchId)
    set({ activeBranchId: branchId })
  },
  setBranches: (branches) => set({ branches: sortBranches(branches), branchesLoaded: true }),
  openSwitcher: (mode = 'list') => set({ switcher: mode }),
  closeSwitcher: () => set({ switcher: 'closed' }),
  openManage: (renamingId) => set({ manageOpen: true, manageRenamingId: renamingId ?? null }),
  closeManage: () => set({ manageOpen: false, manageRenamingId: null }),
  bumpEpoch: () => set((state) => ({ epoch: state.epoch + 1 })),
}))

/**
 * Branches this tab is deleting itself (a delete, or a merge that deletes).
 * The server tombstones the branch and resets its documents before the
 * request returns, so the collab socket's `gone` usually lands first — for
 * these ids it is expected, not news: the tab leaves quietly and the flow
 * that asked refreshes the registry and reports once.
 */
const leaving = new Set<string>()

/**
 * The active branch is gone (deleted from another tab, by another user, or
 * under this very tab): drop back to main once, refresh the registry, and
 * say so. Shared by the HTTP 404 listener and the collab socket's `gone`.
 */
export function fallBackToMain(branchId: string): void {
  const { activeBranchId, setActiveBranch } = useBranchStore.getState()
  if (activeBranchId !== branchId || branchId === MAIN_BRANCH_ID) return
  setActiveBranch(MAIN_BRANCH_ID)
  if (leaving.has(branchId)) return
  void refreshBranchesAfterMutation()
  pushToast({
    kind: 'info',
    title: 'Branch no longer exists',
    body: `The branch "${branchId}" was deleted. You are back on main.`,
  })
}

/**
 * The active branch can disappear under this tab (deleted from another tab
 * or by another user): the next request 404s with the `branch_not_found`
 * code and the tab drops back to main. Registered once, when the
 * authenticated admin loads this module.
 */
registerApiErrorListener((error, request) => {
  if (error.code !== BRANCH_NOT_FOUND_CODE) return
  // Judge by the branch the request was sent for: a request still in flight
  // for a branch this tab has since left must not kick it off the branch it
  // is on now. The hand-rolled fetch sites report no headers; they sent the
  // branch that is active.
  fallBackToMain(request.headers?.[BRANCH_HEADER] ?? useBranchStore.getState().activeBranchId)
})

// ---------------------------------------------------------------------------
// Registry operations. Every mutation applies its own result to the registry
// at once, then re-reads the registry so the switcher, strip, and dialog all
// read one consistent list; that re-read can fail without the mutation —
// which already happened — being reported as failed.
// ---------------------------------------------------------------------------

export async function refreshBranches(signal?: AbortSignal): Promise<SiteBranch[]> {
  const branches = await listCmsBranches(signal)
  useBranchStore.getState().setBranches(branches)
  return branches
}

/** The post-mutation re-read: logged on failure, never thrown. */
async function refreshBranchesAfterMutation(): Promise<void> {
  try {
    await refreshBranches()
  } catch (err) {
    console.error('[branches] failed to refresh branches:', err)
  }
}

function upsertBranch(branch: SiteBranch): void {
  const state = useBranchStore.getState()
  state.setBranches([...state.branches.filter((entry) => entry.id !== branch.id), branch])
}

/** The branch is gone: leave it if this tab is on it, and drop it from the registry. */
function leaveDeletedBranch(branchId: string): void {
  const state = useBranchStore.getState()
  if (state.activeBranchId === branchId) state.setActiveBranch(MAIN_BRANCH_ID)
  state.setBranches(state.branches.filter((entry) => entry.id !== branchId))
}

/** Switch this tab to a branch. A no-op when already there. */
export function switchBranch(branchId: string): void {
  const state = useBranchStore.getState()
  if (state.activeBranchId === branchId) return
  state.setActiveBranch(branchId)
}

/** Fork a branch and switch this tab onto it. */
export async function createBranch(input: CreateBranchBody): Promise<SiteBranch> {
  const branch = await createCmsBranch(input)
  upsertBranch(branch)
  switchBranch(branch.id)
  await refreshBranchesAfterMutation()
  return branch
}

export async function renameBranch(branchId: string, name: string): Promise<SiteBranch> {
  const branch = await renameCmsBranch(branchId, { name })
  upsertBranch(branch)
  await refreshBranchesAfterMutation()
  return branch
}

/**
 * Delete a branch. Callers wrap this in `runStepUp` — the server re-verifies
 * the actor. When the deleted branch is the active one the tab returns to
 * main before the registry refreshes, so no request goes out for it.
 */
export async function deleteBranch(branchId: string): Promise<void> {
  leaving.add(branchId)
  try {
    await deleteCmsBranch(branchId)
  } finally {
    leaving.delete(branchId)
  }
  leaveDeletedBranch(branchId)
  await refreshBranchesAfterMutation()
}

export type BranchMergeResult = ApplyMergeEnvelope

/**
 * Merge a branch into main, or update it from main. Callers wrap this in
 * `runStepUp`. A merge that deletes the branch returns this tab to main;
 * otherwise the active branch's content moved (an update rewrote it, a
 * merge mirrored the result back) and every branch-scoped workspace reloads.
 */
export async function mergeBranch(
  branchId: string,
  direction: MergeDirection,
  body: ApplyMergeBody,
): Promise<BranchMergeResult> {
  if (body.deleteBranch) leaving.add(branchId)
  let result: BranchMergeResult
  try {
    result = await applyCmsBranchMerge(branchId, direction, body)
  } finally {
    leaving.delete(branchId)
  }
  if (result.branchDeleted) leaveDeletedBranch(branchId)
  else useBranchStore.getState().bumpEpoch()
  await refreshBranchesAfterMutation()
  return result
}

/**
 * Reverse the latest merge or update on a branch. Callers wrap this in
 * `runStepUp`. Content moved on the target (and, after a merge, on the
 * branch), so every branch-scoped workspace reloads.
 */
export async function undoBranchMerge(branchId: string, direction: MergeDirection): Promise<UndoMergeEnvelope> {
  const result = await undoCmsBranchMerge(branchId, direction)
  useBranchStore.getState().bumpEpoch()
  await refreshBranchesAfterMutation()
  return result
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export function useActiveBranchId(): string {
  return useBranchStore((state) => state.activeBranchId)
}

export function useBranches(): SiteBranch[] {
  return useBranchStore((state) => state.branches)
}

/** `<branchId>:<epoch>` — the key a branch-scoped workspace remounts on. */
export function useBranchWorkspaceKey(): string {
  return useBranchStore((state) => `${state.activeBranchId}:${state.epoch}`)
}

/**
 * The active branch's registry entry. Before the registry loads (or when the
 * tab was opened straight onto a branch id) the entry is synthesized from the
 * id so the chip and strip never flash "main".
 */
export function useActiveBranch(): SiteBranch {
  return useBranchStore((state) => {
    const found = state.branches.find((branch) => branch.id === state.activeBranchId)
    if (found) return found
    return placeholderBranch(state.activeBranchId)
  })
}

const placeholderCache = new Map<string, SiteBranch>()

function placeholderBranch(id: string): SiteBranch {
  let branch = placeholderCache.get(id)
  if (!branch) {
    const now = new Date(0).toISOString()
    branch = {
      id,
      name: id,
      baseBranchId: id === MAIN_BRANCH_ID ? null : MAIN_BRANCH_ID,
      createdByUserId: null,
      createdAt: now,
      updatedAt: now,
    }
    placeholderCache.set(id, branch)
  }
  return branch
}

export interface BranchPublishGate {
  /** True while the tab edits a branch other than main. */
  onBranch: boolean
  /** The inline reason to show on disabled publish/schedule controls; null on main. */
  reason: string | null
}

export function useBranchPublishGate(): BranchPublishGate {
  const branch = useActiveBranch()
  if (branch.id === MAIN_BRANCH_ID) return { onBranch: false, reason: null }
  return { onBranch: true, reason: BRANCH_PUBLISH_REASON }
}

/** Non-hook read for command palettes and other imperative gates. */
export function isOnMainBranch(): boolean {
  return useBranchStore.getState().activeBranchId === MAIN_BRANCH_ID
}
