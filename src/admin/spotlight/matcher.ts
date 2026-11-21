/**
 * Spotlight fuzzy scorer — §8 of the Command Spotlight master plan.
 *
 * Deterministic, in-house, ~80 LOC. No external dependency.
 *
 * Scoring per token (after whitespace tokenization):
 *   +1000  query (full) is a prefix of title (high-confidence prefix match)
 *   +500   per word-start match in title
 *   +200   per token found as substring in title
 *   +80    per token found as substring in subtitle
 *   +40    per token in any keywords[]
 *   +25    if workspace matches workspaces field
 *   × priorityBoost  (default 1.0)
 *   +150   if in recent list (decayed by position)
 *   +250   if when(ctx) returns true (commands with when()=false are already
 *          filtered out by `filterCommands` upstream)
 *
 * Commands with a zero baseline score are excluded when query is non-empty.
 * Ties broken by group order then alphabetical title.
 */

import type { Command, CommandContext, CommandGroup } from './types'

// Group display order — earlier index = sorted first on tie.
const GROUP_ORDER: CommandGroup[] = [
  'recent',
  'navigation',
  'editor',
  'pages',
  'content',
  'data',
  'media',
  'visualComponents',
  'framework',
  'plugins',
  'users',
  'account',
  'settings',
  'preview',
  'branches',
  'ai',
  'help',
  'results',
]

export interface ScoredCommand {
  command: Command
  score: number
  /** Token positions in title for <mark> highlighting. */
  matchRanges: Array<[start: number, end: number]>
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tokenize(text: string): string[] {
  return text.trim().toLowerCase().split(/\s+/).filter(Boolean)
}

function isWordStart(text: string, index: number): boolean {
  if (index === 0) return true
  const prev = text[index - 1]
  return prev === ' ' || prev === '-' || prev === '_' || prev === '.'
}

/**
 * Collect [start, end) ranges where token appears in haystack (case-insensitive).
 */
function findTokenRanges(haystack: string, token: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  const lower = haystack.toLowerCase()
  let pos = 0
  while (pos <= lower.length - token.length) {
    const idx = lower.indexOf(token, pos)
    if (idx === -1) break
    ranges.push([idx, idx + token.length])
    pos = idx + 1
  }
  return ranges
}

/** Merge overlapping/adjacent ranges, sort by start. */
function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  if (ranges.length === 0) return []
  const sorted = [...ranges].sort((a, b) => a[0] - b[0])
  const merged: Array<[number, number]> = [sorted[0]!]
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1]!
    const curr = sorted[i]!
    if (curr[0] <= last[1]) {
      last[1] = Math.max(last[1], curr[1])
    } else {
      merged.push(curr)
    }
  }
  return merged
}

// ─── Score function ───────────────────────────────────────────────────────────

function scoreCommand(
  command: Command,
  query: string,
  ctx: CommandContext,
  recentIds: ReadonlyArray<string>,
): ScoredCommand | null {
  const q = query.trim().toLowerCase()
  const title = command.title.toLowerCase()
  const subtitle = command.subtitle?.toLowerCase() ?? ''
  const keywords = command.keywords?.map((k) => k.toLowerCase()) ?? []
  const allMatchRanges: Array<[number, number]> = []

  let score = 0
  const priorityBoost = command.priorityBoost ?? 1.0

  if (q !== '') {
    const tokens = tokenize(q)

    // +1000 prefix match (whole query against title)
    if (title.startsWith(q)) {
      score += 1000
      allMatchRanges.push([0, q.length])
    }

    for (const token of tokens) {
      if (token.length === 0) continue

      // +500 per word-start in title
      const titleLower = command.title.toLowerCase()
      for (let i = 0; i <= titleLower.length - token.length; i++) {
        if (titleLower.slice(i, i + token.length) === token && isWordStart(titleLower, i)) {
          score += 500
          allMatchRanges.push([i, i + token.length])
          break  // only count once per token for word-start
        }
      }

      // +200 per token in title (substring)
      const titleRanges = findTokenRanges(command.title, token)
      if (titleRanges.length > 0) {
        score += 200
        allMatchRanges.push(...titleRanges)
      }

      // +80 per token in subtitle
      if (subtitle && subtitle.includes(token)) {
        score += 80
      }

      // +40 per token in keywords
      if (keywords.some((kw) => kw.includes(token))) {
        score += 40
      }
    }

    // Exclude commands with zero score (no match) when query is non-empty
    if (score === 0) return null
  }

  // +25 workspace match
  if (command.workspaces) {
    if (
      command.workspaces.includes('any') ||
      command.workspaces.includes(ctx.workspace)
    ) {
      score += 25
    }
  }

  // × priorityBoost
  score = Math.round(score * priorityBoost)

  // +150 recent (decayed by position: 150 for most recent, down to 0 for 8th)
  const recentIndex = recentIds.indexOf(command.id)
  if (recentIndex !== -1) {
    const decay = Math.max(0, 150 - recentIndex * 20)
    score += decay
  }

  // +250 when(ctx) returns true
  if (command.when) {
    try {
      if (command.when(ctx)) {
        score += 250
      }
    } catch (_err) {
      // when() predicate failures are silently ignored
    }
  }

  return {
    command,
    score,
    matchRanges: mergeRanges(allMatchRanges),
  }
}

// ─── Sort comparator ──────────────────────────────────────────────────────────

function groupOrder(group: CommandGroup): number {
  const idx = GROUP_ORDER.indexOf(group)
  return idx === -1 ? 999 : idx
}

function compareScored(a: ScoredCommand, b: ScoredCommand): number {
  // Higher score first
  if (b.score !== a.score) return b.score - a.score
  // Then by group order
  const gDiff = groupOrder(a.command.group) - groupOrder(b.command.group)
  if (gDiff !== 0) return gDiff
  // Then alphabetical
  return a.command.title.localeCompare(b.command.title)
}

// ─── Public API ───────────────────────────────────────────────────────────────

const MAX_RESULTS = 50

/**
 * Score and rank a set of commands against a query.
 * Returns at most MAX_RESULTS sorted results (highest score first).
 * When query is empty, all commands pass through (for empty-state display).
 */
export function rankCommands(
  commands: Command[],
  query: string,
  ctx: CommandContext,
  recentIds: ReadonlyArray<string>,
): ScoredCommand[] {
  const scored: ScoredCommand[] = []

  for (const cmd of commands) {
    const result = scoreCommand(cmd, query, ctx, recentIds)
    if (result !== null) {
      scored.push(result)
    }
  }

  scored.sort(compareScored)
  return scored.slice(0, MAX_RESULTS)
}

