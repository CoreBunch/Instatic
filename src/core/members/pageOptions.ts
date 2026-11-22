/**
 * How the page assigned to a Member settings slot stands. One reading for
 * the settings dialog and the Members tab, so both say the same thing.
 */
import type { MemberPageOption } from './adminSchemas'
import { MEMBER_PAGE_FORM_ACTIONS, memberFormAction } from './formActions'
import type { MemberPageKey, MemberPages } from './schemas'

export type MemberPageState =
  | { kind: 'unset' }
  /** The assigned page no longer exists. */
  | { kind: 'missing' }
  | { kind: 'unpublished'; page: MemberPageOption }
  /** Published, but the form the slot needs was not found on the page. */
  | { kind: 'no_form'; page: MemberPageOption; formLabel: string }
  | { kind: 'ready'; page: MemberPageOption }

export function memberPageState(
  key: MemberPageKey,
  pages: MemberPages,
  options: readonly MemberPageOption[],
): MemberPageState {
  const pageId = pages[key]
  if (!pageId) return { kind: 'unset' }
  const page = options.find((option) => option.id === pageId)
  if (!page) return { kind: 'missing' }
  if (page.publishedPath === null) return { kind: 'unpublished', page }
  const needed: readonly string[] = MEMBER_PAGE_FORM_ACTIONS[key]
  if (needed.length > 0 && !needed.some((action) => page.formActions.includes(action))) {
    return { kind: 'no_form', page, formLabel: memberFormAction(needed[0]!)?.label ?? needed[0]! }
  }
  return { kind: 'ready', page }
}

/** Does the slot's link lead to a live page? The server applies the same rule. */
export function memberPageIsLive(
  key: MemberPageKey,
  pages: MemberPages,
  options: readonly MemberPageOption[],
): boolean {
  const state = memberPageState(key, pages, options)
  return state.kind === 'ready' || state.kind === 'no_form'
}
