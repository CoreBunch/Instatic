/**
 * RichTextBubble — renders a message text block with inline clickable
 * layer-mention pills. User messages use stored mentions; assistant messages
 * are scanned for mention patterns and validated against the current page.
 * Text without mentions falls back to markdown rendering (bold, lists, code).
 */
import { memo, useCallback } from 'react'
import { useEditorStore } from '@site/store/store'
import type { BaseNode, SiteDocument } from '@core/page-tree'
import { renderMarkdownToHtml } from '@site/agent'
import { cn } from '@ui/cn'
import { pillAccent, pillAccentVar } from '@ui/pillAccent'
import { getMentionLabelForNode } from '@site/agent/mentionLabel'
import type { AgentMessageMention } from '@site/agent'
import styles from './AgentPanel.module.css'

interface RichTextBubbleProps {
  text: string
  isUser: boolean
  mentions?: AgentMessageMention[]
}

/**
 * Matches layer references like "Layer abc123", "Module <abc123>",
 * "Elements \`def456\`, \`ghi789\`", etc. Accepts multiple prefix words
 * (Layer, Module, Element, Node, Section, Component) with optional plural
 * 's' and optional angle-brackets or backticks around each id.
 */
const MENTION_RE = /\b(?:Layer|Module|Element|Node|Section|Component)s?\s+((?:<|`)?[A-Za-z0-9_-]+(?:>|`)?(?:,\s*(?:<|`)?[A-Za-z0-9_-]+(?:>|`)?)*)/i

function scanMentions(text: string): RegExpExecArray[] {
  const matches: RegExpExecArray[] = []
  const re = new RegExp(MENTION_RE.source, 'gi')
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    matches.push(match)
  }
  return matches
}

function useNodeSelector() {
  const selectNode = useCallback(
    (nodeId: string) => {
      try {
        useEditorStore.getState().selectNode(nodeId, 'replace')
      } catch {
        // Content workspace or missing store — silently ignore.
      }
    },
    [],
  )
  return selectNode
}

function MentionPill({ label, nodeId }: { label: string; nodeId: string }) {
  const selectNode = useNodeSelector()
  const state = useEditorStore.getState()
  const site = state.site
  const page = site?.pages.find((p) => p.id === state.activePageId)
  let colorKey = nodeId
  try {
    colorKey = getMentionLabelForNode(nodeId, page?.nodes[nodeId], site).colorKey
  } catch {
    // Node deleted — fall back to nodeId for color generation
  }
  return (
    <span
      className={styles.mentionPill}
      data-node-id={nodeId}
      style={{ color: pillAccentVar(pillAccent(colorKey)) }}
      onClick={(e) => {
        e.stopPropagation()
        selectNode(nodeId)
      }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          selectNode(nodeId)
        }
      }}
    >
      {label}
    </span>
  )
}

/**
 * Split text by a set of known mention labels and render each mention as a
 * clickable pill. Unmatched text is rendered as a plain <span>.
 */
function renderWithStoredMentions(
  text: string,
  mentions: AgentMessageMention[],
): React.ReactNode[] {
  const segments: React.ReactNode[] = []
  let remaining = text

  for (const mention of mentions) {
    const idx = remaining.indexOf(mention.label)
    if (idx === -1) continue
    if (idx > 0) {
      segments.push(
        <span key={`t-${segments.length}`}>{remaining.slice(0, idx)}</span>,
      )
    }
    segments.push(
      <MentionPill
        key={`m-${mention.nodeId}-${segments.length}`}
        nodeId={mention.nodeId}
        label={mention.label}
      />,
    )
    remaining = remaining.slice(idx + mention.label.length)
  }

  if (remaining) {
    segments.push(<span key={`t-${segments.length}`}>{remaining}</span>)
  }

  return segments.length > 0 ? segments : [text]
}

/**
 * Scan assistant text for "Layer abc123" or "Layers abc123, def456" patterns
 * and render matching nodeIds as pills. All other text stays plain.
 */
function renderWithScannedMentions(text: string): React.ReactNode[] {
  const segments: React.ReactNode[] = []
  let lastIndex = 0

  // Get current page node ids for validation + mention label registry
  let validNodeIds: Set<string> | null = null
  let mentionLabels: Record<string, string> = {}
  let page: { nodes: Record<string, BaseNode> } | undefined
  let site: SiteDocument | null = null
  try {
    const state = useEditorStore.getState()
    site = state.site
    const activePageId = state.activePageId
    page = site?.pages.find((p) => p.id === activePageId)
    if (page?.nodes) {
      validNodeIds = new Set(Object.keys(page.nodes))
    }
    mentionLabels = state.agentMentionLabels ?? {}
  } catch {
    // No editor store available (content workspace)
  }

  for (const match of scanMentions(text)) {
    const [fullMatch, idsStr] = match
    const start = match.index
    const ids = idsStr
      .split(',')
      .map((s) => s.trim().replace(/^[<`]+|[>`]+$/g, ''))

    // Preserve the original prefix word (Layer, Module, Node, etc.)
    const prefixMatch = fullMatch.match(/^\S+/)
    const prefix = prefixMatch ? prefixMatch[0] : 'Layer'

    // Push plain text before the match
    if (start > lastIndex) {
      segments.push(
        <span key={`t-${segments.length}`}>{text.slice(lastIndex, start)}</span>,
      )
    }

    // Render each id as a pill with a human-readable label if it looks valid
    const pills: React.ReactNode[] = []
    ids.forEach((id, i) => {
      const cachedLabel = mentionLabels[id]
      const isValid = !validNodeIds || validNodeIds.has(id)
      if (cachedLabel) {
        // Known from registry (may be deleted) — render as pill
        pills.push(
          <MentionPill
            key={`m-${id}-${segments.length}-${i}`}
            nodeId={id}
            label={cachedLabel}
          />,
        )
      } else if (isValid) {
        // Still exists in page — resolve fresh
        const { label } = getMentionLabelForNode(id, page?.nodes[id], site)
        pills.push(
          <MentionPill
            key={`m-${id}-${segments.length}-${i}`}
            nodeId={id}
            label={label}
          />,
        )
      } else {
        // Unknown deleted node — plain text fallback
        pills.push(
          <span key={`m-${id}-${segments.length}-${i}`}>{prefix} {id}</span>,
        )
      }
      if (i < ids.length - 1) {
        pills.push(<span key={`sep-${segments.length}-${i}`}>, </span>)
      }
    })

    // Preserve the original prefix word in the rendered output
    segments.push(
      <span key={`g-${segments.length}`}>
        {prefix} {pills}
      </span>,
    )

    lastIndex = start + fullMatch.length
  }

  // Remaining plain text
  if (lastIndex < text.length) {
    segments.push(<span key={`t-${segments.length}`}>{text.slice(lastIndex)}</span>)
  }

  return segments.length > 0 ? segments : [text]
}

// Exception: React.memo re-render bailout on a hot, list-rendered component.
const RichTextBubble = memo(function RichTextBubble({
  text,
  isUser,
  mentions,
}: RichTextBubbleProps) {
  const hasStoredMentions = mentions && mentions.length > 0

  if (hasStoredMentions) {
    return (
      <div
        className={cn(
          styles.messageText,
          isUser ? styles.messageTextUser : styles.messageTextAssistant,
        )}
      >
        {renderWithStoredMentions(text, mentions!)}
      </div>
    )
  }

  // Assistant text — scan for mention patterns
  if (!isUser && scanMentions(text).length > 0) {
    return (
      <div
        className={cn(
          styles.messageText,
          styles.messageTextAssistant,
        )}
      >
        {renderWithScannedMentions(text)}
      </div>
    )
  }

  // No mentions — render markdown for assistants, plain text for users
  const html = !isUser ? renderMarkdownToHtml(text) : null
  if (html) {
    return (
      <div
        className={cn(
          styles.messageText,
          styles.messageTextAssistant,
          styles.markdownText,
        )}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    )
  }

  return (
    <div
      className={cn(
        styles.messageText,
        isUser ? styles.messageTextUser : styles.messageTextAssistant,
      )}
    >
      {text}
    </div>
  )
})

export { RichTextBubble }
