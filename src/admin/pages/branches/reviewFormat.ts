/**
 * Labels and grouping the merge review uses: how a change's kind and action
 * read, which filter a change belongs to, and short relative times.
 */
import type { MergeChange, MergeRequestStatus } from '@core/branches'
import { formatRelativeTime } from '@core/utils/relativeTime'
import type { TagPillTone } from '@ui/components/TagPill'

export const REVIEW_FILTERS = ['all', 'pages', 'content', 'files', 'conflicts', 'comments'] as const
export type ReviewFilter = (typeof REVIEW_FILTERS)[number]

export const FILTER_LABELS: Record<ReviewFilter, string> = {
  all: 'All',
  pages: 'Pages',
  content: 'Content',
  files: 'Files',
  conflicts: 'Conflicts',
  comments: 'With comments',
}

/** Rows of these tables render as pages (before/after frames). */
export function isPageChange(change: MergeChange): boolean {
  return change.kind === 'row' && change.tableId === 'pages'
}

export function changeKindLabel(change: MergeChange): string {
  if (change.kind === 'site') return 'Site settings'
  if (change.kind === 'file') return 'File'
  if (change.kind === 'table') return 'Table'
  if (isPageChange(change)) return 'Page'
  return change.tableName ? `Entry · ${change.tableName}` : 'Entry'
}

export const ACTION_TONE: Record<MergeChange['action'], TagPillTone> = { create: 'success', update: 'warning', delete: 'danger' }
export const ACTION_WORD: Record<MergeChange['action'], string> = { create: 'new', update: 'changed', delete: 'removed' }

export function matchesFilter(change: MergeChange, filter: ReviewFilter, commentCount: number): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'pages':
      return isPageChange(change)
    case 'content':
      return (change.kind === 'row' && !isPageChange(change)) || change.kind === 'table'
    case 'files':
      return change.kind === 'file' || change.kind === 'site'
    case 'conflicts':
      return change.conflicts.length > 0
    case 'comments':
      return commentCount > 0
  }
}

export function requestStatusLabel(status: MergeRequestStatus): string {
  switch (status) {
    case 'open':
      return 'Awaiting review'
    case 'declined':
      return 'Changes requested'
    case 'merged':
      return 'Merged'
    case 'withdrawn':
      return 'Withdrawn'
  }
}

/** The state badge's tone; a withdrawn request is plain (muted). */
export function requestStatusTone(status: MergeRequestStatus): TagPillTone | null {
  switch (status) {
    case 'open':
      return 'warning'
    case 'declined':
      return 'danger'
    case 'merged':
      return 'success'
    case 'withdrawn':
      return null
  }
}

/** "3m" / "2h" / "4d" from an ISO timestamp; empty when unparsable. */
export function relativeIso(iso: string): string {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return ''
  return formatRelativeTime(ms)
}

/**
 * The same stamp as a past-tense phrase — "3m ago", "4d ago".
 *
 * Under a minute `formatRelativeTime` says "now", which reads as "now ago"
 * once a caller appends the word, so that case becomes "just now" instead.
 * Callers that render a bare stamp want `relativeIso`.
 */
export function relativeIsoAgo(iso: string): string {
  const stamp = relativeIso(iso)
  if (!stamp) return ''
  return stamp === 'now' ? 'just now' : `${stamp} ago`
}

/** Every comment on the request itself uses the empty key. */
export const REQUEST_ENTITY_KEY = ''
