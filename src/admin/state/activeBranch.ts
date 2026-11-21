/**
 * The active branch id — the one piece of branch state the admin ENTRY needs
 * before anything else loads: every request must carry the branch header
 * from the first fetch, so the header provider is installed at boot from
 * this tiny module. The store (`branchStore.ts`) builds on it; nothing here
 * pulls in Zustand, the persistence layer, or the UI.
 *
 * Persistence is per TAB (`sessionStorage`), so two tabs can sit on two
 * branches; a `?branch=` query param on any admin URL overrides the stored
 * value so links into a branch are shareable. Main needs no header.
 */
import { MAIN_BRANCH_ID, isValidBranchId } from '@core/branches'
import { registerRequestHeaderProvider } from '@core/http'

export const ACTIVE_BRANCH_STORAGE_KEY = 'instatic-active-branch'
export const BRANCH_QUERY_PARAM = 'branch'
/** The request header carrying the branch; the server reads it case-insensitively. */
export const BRANCH_HEADER = 'X-Instatic-Branch'

function readStoredBranch(): string {
  if (typeof window === 'undefined') return MAIN_BRANCH_ID
  try {
    const url = new URL(window.location.href)
    const fromUrl = url.searchParams.get(BRANCH_QUERY_PARAM)
    if (fromUrl !== null) {
      // Consumed once: leaving it in the URL would re-seed the branch on
      // every reload, undoing a later switch to main or a deletion.
      url.searchParams.delete(BRANCH_QUERY_PARAM)
      window.history.replaceState(window.history.state, '', url)
    }
    if (fromUrl && isValidBranchId(fromUrl)) {
      window.sessionStorage.setItem(ACTIVE_BRANCH_STORAGE_KEY, fromUrl)
      return fromUrl
    }
    const stored = window.sessionStorage.getItem(ACTIVE_BRANCH_STORAGE_KEY)
    return stored && isValidBranchId(stored) ? stored : MAIN_BRANCH_ID
  } catch {
    // sessionStorage can throw in privacy modes — main is always safe.
    return MAIN_BRANCH_ID
  }
}

let activeBranchId: string = readStoredBranch()

/** The branch this tab addresses right now. */
export function currentBranchId(): string {
  return activeBranchId
}

/** Record the tab's branch; the header provider reads it on the next request. */
export function rememberBranchId(branchId: string): void {
  activeBranchId = branchId
  if (typeof window === 'undefined') return
  try {
    if (branchId === MAIN_BRANCH_ID) window.sessionStorage.removeItem(ACTIVE_BRANCH_STORAGE_KEY)
    else window.sessionStorage.setItem(ACTIVE_BRANCH_STORAGE_KEY, branchId)
  } catch {
    // Persistence is a convenience; the in-memory value still drives requests.
  }
}

/** The branch header every admin request should carry; empty on main. */
export function activeBranchHeaders(): Record<string, string> {
  return activeBranchId === MAIN_BRANCH_ID ? {} : { [BRANCH_HEADER]: activeBranchId }
}

/** Wire the header into the HTTP layer. Called once by the admin entry. */
export function installBranchRequestHeaders(): void {
  registerRequestHeaderProvider(activeBranchHeaders)
}
