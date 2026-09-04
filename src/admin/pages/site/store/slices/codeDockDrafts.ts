/**
 * Code Dock drafts — the panels' unapplied buffers, kept in the store so
 * they outlive the panel component: expanding a panel into its dialog,
 * the narrow-window tab fallback, and leaving/entering God Mode all
 * remount the panels, and an edit the user has not been able to apply yet
 * must never vanish on the way.
 *
 * Keyed by the panel's document key. Bounded: past `MAX_CODE_DOCK_DRAFTS`
 * the oldest abandoned drafts go first (insertion order). Not persisted —
 * drafts reference live node ids.
 */
import type { DestructiveRemoval } from '@site/code-dock/html/applyGuardrails'

/** Why the HTML panel's last live flush did not apply a draft. */
export type HtmlDraftHold =
  | { kind: 'destructive'; removals: DestructiveRemoval[] }
  | { kind: 'error'; message: string }

export interface HtmlPanelDraft {
  kind: 'html'
  text: string
  syntaxErrorCount: number
  /** The projection the draft was started from — differs once stale. */
  baseHtml: string
  /** The node the draft is scoped to — gone once orphaned. */
  rootId: string
  /** The scope's layer-panel name when the draft started, for the orphan banner. */
  name: string
  held: HtmlDraftHold | null
}

/** A CSS buffer that does not parse yet, so the live apply skipped it. */
export interface CssPanelDraft {
  kind: 'css'
  text: string
  syntaxErrorCount: number
}

export type CodeDockDraft = HtmlPanelDraft | CssPanelDraft

export const MAX_CODE_DOCK_DRAFTS = 20

/** `drafts` with `draft` stored (or removed, for null) under `key`, bounded. */
export function withCodeDockDraft(
  drafts: Record<string, CodeDockDraft>,
  key: string,
  draft: CodeDockDraft | null,
): Record<string, CodeDockDraft> {
  const { [key]: _previous, ...others } = drafts
  if (draft === null) return others
  const keys = Object.keys(others)
  const kept = keys.length >= MAX_CODE_DOCK_DRAFTS ? keys.slice(keys.length - MAX_CODE_DOCK_DRAFTS + 1) : keys
  const next: Record<string, CodeDockDraft> = {}
  for (const other of kept) next[other] = others[other]
  next[key] = draft
  return next
}
