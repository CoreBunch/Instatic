/**
 * AgentPanel — self-contained floating AI assistant panel (Guideline #410).
 *
 * This component renders its own floating overlay container — positioned at
 * bottom-right of the canvas area. Visibility is controlled by `isAgentOpen`
 * in the agentSlice. Always-mounted (CSS display:none when closed) to preserve
 * Zustand conversation state across open/close cycles.
 *
 * Runtime model:
 * - Agent calls stream through `/admin/api/ai/chat/site`.
 * - The Bun server selects the configured provider credential and model.
 * - Drivers call provider REST/SSE endpoints directly; no provider SDK runs.
 *
 * Accessibility (WCAG 2.1 AA):
 * - role="complementary" + aria-label="AI Assistant" on the panel landmark
 * - role="log" + aria-live="polite" on the message thread
 * - role="alert" for error messages
 * - role="status" for tool call status badges
 * - keyboard: Escape closes the panel
 *
 * @see Guideline #410 — 3 Self-Contained Independent Panels
 */

import { useRef, useEffect, memo } from 'react'
import { useAgentStore } from '@admin/ai/useAgentStore'
import { useAsyncResource } from '@admin/lib/useAsyncResource'
import { useAdminNavigate } from '@admin/lib/useAdminNavigate'
import { listCredentials, listModels } from '@admin/ai/api'
import { renderMarkdownToHtml, type AgentMessage, type AgentToolCall } from '@site/agent'
import { TrashSolidIcon } from 'pixel-art-icons/icons/trash-solid'
import { SquareSolidIcon } from 'pixel-art-icons/icons/square-solid'
import { SendSolidIcon } from 'pixel-art-icons/icons/send-solid'
import { LoaderIcon } from 'pixel-art-icons/icons/loader'
import { CheckIcon } from 'pixel-art-icons/icons/check'
import { CircleAlertSolidIcon } from 'pixel-art-icons/icons/circle-alert-solid'
import { AiBoxSolidIcon } from 'pixel-art-icons/icons/ai-box-solid'
import { AiSettingsSolidIcon } from 'pixel-art-icons/icons/ai-settings-solid'
import { EditSolidIcon } from 'pixel-art-icons/icons/edit-solid'
import { ArrowRightIcon } from 'pixel-art-icons/icons/arrow-right'
import { PanelHeader } from '@admin/shared/PanelHeader'
import { Button } from '@ui/components/Button'
import { EmptyState } from '@ui/components/EmptyState'
import { Textarea } from '@ui/components/Input'
import { useDraggablePanel } from '@site/hooks/useDraggablePanel'
import { cn } from '@ui/cn'
import { ModelPicker } from './ModelPicker'
import { ConversationHistory } from './ConversationHistory'
import { ContextMeter } from './ContextMeter'
import styles from './AgentPanel.module.css'

const PANEL_WIDTH = 320
const PANEL_HEIGHT = 480
const AI_SETTINGS_ROUTE = '/admin/ai'
type PanelVariant = 'floating' | 'docked'

// ---------------------------------------------------------------------------
// AgentPanel
// ---------------------------------------------------------------------------

/**
 * AgentPanel — all store subscriptions, refs, effects, and render logic.
 *
 * Always-mounted by EditorLayout — visibility is controlled via CSS display:none
 * (`.floatPanelClosed`) to preserve Zustand conversation state across open/close cycles.
 * Agent routes via Vite proxy `/admin/api/agent` → local Bun server → Claude SDK.
 */
export function AgentPanel({ variant = 'floating' }: { variant?: PanelVariant }) {
  const isOpen = useAgentStore((s) => s.isAgentOpen)
  const isStreaming = useAgentStore((s) => s.isAgentStreaming)
  const messages = useAgentStore((s) => s.agentMessages)
  const agentError = useAgentStore((s) => s.agentError)
  const closeAgent = useAgentStore((s) => s.closeAgent)
  const sendAgentMessage = useAgentStore((s) => s.sendAgentMessage)
  const abortAgent = useAgentStore((s) => s.abortAgent)
  const clearAgentMessages = useAgentStore((s) => s.clearAgentMessages)
  const startNewAgentConversation = useAgentStore((s) => s.startNewAgentConversation)
  const loadScopeDefault = useAgentStore((s) => s.loadScopeDefault)
  const activeCredentialId = useAgentStore((s) => s.agentActiveCredentialId)
  const activeModelId = useAgentStore((s) => s.agentActiveModelId)
  const credentialsResource = useAsyncResource(
    (signal) => listCredentials(signal),
    [],
    { swallowErrors: true },
  )
  const credentials = credentialsResource.data ?? []
  const credentialsLoaded = credentialsResource.data !== null || !credentialsResource.loading
  const noCredentials = credentialsLoaded && credentials.length === 0
  const noProviderError = agentError?.startsWith('No AI provider configured') ?? false
  // The composer can't run a turn without an active (credential, model) — one
  // is either preloaded from the scope default or picked in the model picker.
  // Locking off `hasActiveProvider` (not a sticky error string) is what keeps
  // the composer usable the instant the user picks a model.
  const hasActiveProvider = Boolean(activeCredentialId && activeModelId)
  const composerLocked = !hasActiveProvider
  // Why the composer is locked, used for the empty-state + placeholder copy:
  //   'setup'       → no credentials exist at all → add one in AI settings.
  //   'chooseModel' → credentials exist but no scope default / pick yet →
  //                   choose a model below, or set a default in AI settings.
  // While credentials are still loading we keep messaging neutral (null) so
  // the panel doesn't flash a setup prompt before the default preload lands.
  const lockReason: 'setup' | 'chooseModel' | null = !composerLocked
    ? null
    : noCredentials
      ? 'setup'
      : credentialsLoaded
        ? 'chooseModel'
        : null

  // Resolve the active model's context window from the catalogue (via the
  // models endpoint) so the composer meter can show "0 / window" before the
  // first turn. Re-runs whenever the selected credential/model changes; null
  // until a model is picked, or when the provider has no published window
  // (Ollama / uncatalogued) — the meter then stays hidden.
  const activeProviderId =
    credentials.find((c) => c.id === activeCredentialId)?.providerId ?? null
  const contextWindowResource = useAsyncResource(
    async () => {
      if (!activeProviderId || !activeCredentialId || !activeModelId) return null
      const models = await listModels(activeProviderId, activeCredentialId)
      return models.find((m) => m.id === activeModelId)?.contextWindow ?? null
    },
    [activeProviderId, activeCredentialId, activeModelId],
    { swallowErrors: true },
  )

  const inputRef = useRef<HTMLTextAreaElement>(null)
  const threadRef = useRef<HTMLDivElement>(null)

  // ── Draggable panel position ───────────────────────────────────────────────
  // Default to bottom-right corner.
  const { panelRef, headerDragProps, panelPositionStyle } = useDraggablePanel(
    'agent',
    () => ({
      x: typeof window !== 'undefined' ? window.innerWidth - PANEL_WIDTH - 16 : 16,
      y: typeof window !== 'undefined'
        ? window.innerHeight - PANEL_HEIGHT - 16
        : 200,
    }),
  )

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    const el = threadRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  // Focus input when panel becomes active (isOpen transitions to true).
  // The 50ms delay lets the panel's open transition settle before we steal
  // focus; cleanup cancels the pending focus if the panel closes again
  // (or the component unmounts) before the timer fires.
  useEffect(() => {
    if (!isOpen) return
    const id = setTimeout(() => inputRef.current?.focus(), 50)
    return () => clearTimeout(id)
  }, [isOpen])

  // Preload the per-scope default credential + model when the panel opens, so
  // the picker shows the configured default immediately and the first send
  // uses it. The action no-ops if a conversation or explicit pick already
  // exists, so re-opens are cheap.
  useEffect(() => {
    if (isOpen) void loadScopeDefault()
  }, [isOpen, loadScopeDefault])

  // Escape key — close the AI panel
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && isOpen) {
        e.preventDefault()
        closeAgent()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [isOpen, closeAgent])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const input = inputRef.current
    if (!input) return
    const content = input.value.trim()
    if (!content || isStreaming) return
    input.value = ''
    input.style.height = 'auto'
    await sendAgentMessage(content)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit(e as unknown as React.FormEvent)
    }
  }

  // Always-mounted: CSS display:none when closed (via .floatPanelClosed) preserves
  // Zustand state across open/close cycles without conditional rendering.
  return (
    <aside
      ref={panelRef as React.RefObject<HTMLElement>}
      role="complementary"
      aria-label="AI Assistant"
      data-panel=""
      tabIndex={-1}
      onClick={(e) => e.stopPropagation()}
      // Panel position is drag-driven — CSS var injection from useDraggablePanel
      style={variant === 'floating' ? panelPositionStyle : undefined}
      className={cn(
        styles.floatPanel,
        variant === 'docked' && styles.floatPanelDocked,
        !isOpen && styles.floatPanelClosed,
      )}
    >
    <div
      data-testid="agent-panel"
      className={styles.panel}
    >
      {/* ── Shared Panel Header — drag handle + close + clear actions ──────── */}
      <PanelHeader
        panelId="agent"
        title="AI Assistant"
        onClose={closeAgent}
        dragHandleProps={variant === 'floating' ? headerDragProps : undefined}
      >
        {/* History popover — list past chats, start a new one, delete. */}
        <ConversationHistory />
        {/* "New chat" — start a fresh conversation directly from the header. */}
        <Button
          variant="ghost"
          size="xs"
          iconOnly
          onClick={startNewAgentConversation}
          tooltip="New chat"
          aria-label="New chat"
          data-testid="agent-new-chat-header-button"
        >
          <EditSolidIcon size={14} />
        </Button>
        {/* "Clear conversation" — shown when there are messages */}
        {messages.length > 0 && (
          <Button
            variant="ghost"
            size="xs"
            iconOnly
            onClick={clearAgentMessages}
            tooltip="Clear conversation"
            aria-label="Clear conversation"
          >
            <TrashSolidIcon size={14} />
          </Button>
        )}
        {isStreaming && (
          <span className={styles.streamingBadge}>
            <span className={styles.streamingDot} aria-hidden="true" />
            Working…
          </span>
        )}
        {/* "AI settings" — always available; routes to /admin/ai. */}
        <AgentSettingsButton
          variant="header"
          label="AI settings"
          data-testid="agent-settings-header-button"
        />
      </PanelHeader>

      {/* ── Message thread ──────────────────────────────────────────────────── */}
      <div
        ref={threadRef}
        role="log"
        aria-live="polite"
        aria-atomic="false"
        aria-relevant="additions text"
        aria-label="Conversation"
        aria-busy={isStreaming}
        className={styles.thread}
      >
        {messages.length === 0 ? (
          <AgentEmptyState mode={lockReason ?? 'prompt'} />
        ) : (
          <>
            {lockReason && <AgentCredentialAlert mode={lockReason} />}
            {messages.map((msg) => <MessageBubble key={msg.id} msg={msg} />)}
          </>
        )}

        {/* Generic error banner — only show when it's NOT the dedicated
            no-credential message (which renders via the setup empty state). */}
        {agentError && !noProviderError && (
          <div role="alert" className={styles.errorBanner}>
            {agentError}
          </div>
        )}
      </div>

      {/* ── Input bar ───────────────────────────────────────────────────────── */}
      <div className={styles.inputBar}>
        {/* Live context-window meter — renders once the active model's window
            is known (pre-turn shows 0 / window). */}
        <ContextMeter windowTokens={contextWindowResource.data} />
        <form onSubmit={handleSubmit} className={styles.inputForm}>
          {/* Textarea is hidden while streaming — the controls row collapses
              to just the model picker + Stop button. */}
          {!isStreaming && (
            <Textarea
              ref={inputRef}
              placeholder={lockReason === 'setup'
                ? 'Add AI credentials to start chatting'
                : lockReason === 'chooseModel'
                  ? 'Choose a model below to start'
                  : 'Tell me what to build… (Enter to send)'}
              aria-label="Message to AI assistant"
              rows={2}
              resize="none"
              disabled={composerLocked}
              onKeyDown={handleKeyDown}
              onChange={(e) => {
                // Auto-grow textarea
                e.target.style.height = 'auto'
                e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`
              }}
            />
          )}
          {/* Controls row: model picker on the left (saves vertical space),
              minimal icon-only send/stop button on the right. */}
          <div className={styles.inputControls}>
            <ModelPicker
              className={styles.inputControlsPicker}
              credentials={credentials}
              credentialsLoaded={credentialsLoaded}
              onRefreshCredentials={credentialsResource.refresh}
            />
            {isStreaming ? (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                iconOnly
                onClick={abortAgent}
                tooltip="Stop"
                aria-label="Stop"
              >
                <SquareSolidIcon size={14} />
              </Button>
            ) : (
              <Button
                type="submit"
                variant="primary"
                size="sm"
                iconOnly
                disabled={composerLocked}
                tooltip={lockReason === 'setup'
                  ? 'Add AI credentials first'
                  : lockReason === 'chooseModel'
                    ? 'Choose a model first'
                    : 'Send'}
                aria-label="Send"
              >
                <SendSolidIcon size={14} />
              </Button>
            )}
          </div>
        </form>
      </div>
    </div>
    </aside>
  )
}

// ---------------------------------------------------------------------------
// MessageBubble
// ---------------------------------------------------------------------------

interface MessageBubbleProps {
  msg: AgentMessage
}

// Exception #2: React.memo re-render bailout on a hot, list-rendered component
// (one per message in messages.map).
const MessageBubble = memo(function MessageBubble({ msg }: MessageBubbleProps) {
  const isUser = msg.role === 'user'

  return (
    <div className={cn(styles.messageBubble, isUser ? styles.messageBubbleUser : styles.messageBubbleAssistant)}>
      {/* Role label */}
      <div className={styles.roleLabel}>
        {isUser ? 'You' : 'Assistant'}
      </div>

      {/* Chronological blocks — text and tool calls render in the order
          Claude actually emitted them, so a "text → tool → text" sequence
          shows two separate text bubbles around the tool badges. Text is
          rendered as markdown (bold, lists, inline code, links, …) via a
          DOMPurify-sanitised HTML pipeline. */}
      {msg.blocks.map((block, index) =>
        block.kind === 'text' ? (
          <MarkdownTextBubble
            // Stable key per text block: text deltas append in place, so each
            // run of text gets its position-based key.
            key={`text-${index}`}
            text={block.text}
            isUser={isUser}
          />
        ) : (
          <div key={block.toolCall.id} className={styles.toolCallsContainer}>
            <ToolCallBadge toolCall={block.toolCall} />
          </div>
        ),
      )}
    </div>
  )
})

// ---------------------------------------------------------------------------
// MarkdownTextBubble — parses + sanitises the block text and injects it via
// dangerouslySetInnerHTML. Memoised render so streaming deltas don't re-parse
// markdown for unchanged blocks.
// ---------------------------------------------------------------------------

interface MarkdownTextBubbleProps {
  text: string
  isUser: boolean
}

// Exception #2: React.memo re-render bailout on a hot, list-rendered component
// (one per text block, re-rendered on every streaming delta).
const MarkdownTextBubble = memo(function MarkdownTextBubble({
  text,
  isUser,
}: MarkdownTextBubbleProps) {
  const html = renderMarkdownToHtml(text)
  // Empty/whitespace-only blocks don't render at all (avoids stray bubbles
  // around stripped-out tool blocks during streaming).
  if (!html) return null
  return (
    <div
      className={cn(
        styles.contentBubble,
        isUser ? styles.contentBubbleUser : styles.contentBubbleAssistant,
        styles.markdownBubble,
      )}
      // Safe: sanitised by DOMPurify (via sanitizeRichtext) before reaching here.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
})

// ---------------------------------------------------------------------------
// ToolCallBadge
// ---------------------------------------------------------------------------

function ToolCallBadge({ toolCall }: { toolCall: AgentToolCall }) {
  const isPending = toolCall.status === 'pending'
  const isSuccess = toolCall.status === 'success'
  const isError = toolCall.status === 'error'

  const iconClass = isPending
    ? styles.toolCallIconPending
    : isSuccess
    ? styles.toolCallIconSuccess
    : styles.toolCallIconFailed
  const displayType = formatToolCallType(toolCall.actionType)
  const label = formatActionLabel(toolCall.actionType, toolCall.params)
  const statusLabel = isPending
    ? `Running ${displayType}${label ? ` — ${label}` : ''}`
    : isSuccess
    ? `Completed ${displayType}${label ? ` — ${label}` : ''}`
    : `Failed ${displayType}${label ? ` — ${label}` : ''}`

  // Surface the tool's error message directly in the badge stream so the
  // user sees WHY a tool failed without having to dig through devtools. The
  // toolResult handler in agentSlice.ts already populates `result.error`.
  const errorMessage = isError ? toolCall.result?.error ?? 'Tool call failed.' : null

  return (
    <>
      <div
        role="status"
        aria-label={statusLabel}
        className={styles.toolCallBadge}
      >
        <span className={iconClass} aria-hidden="true">
          {isPending ? (
            <LoaderIcon size={10} />
          ) : isSuccess ? (
            <CheckIcon size={10} />
          ) : (
            <CircleAlertSolidIcon size={10} />
          )}
        </span>
        <span className={styles.toolCallType} aria-hidden="true">
          {displayType}
        </span>
        <span aria-hidden="true">{label}</span>
      </div>
      {errorMessage && (
        <p
          role="alert"
          // Tone-aligned with `.errorBanner` (red text on muted background)
          // but inline + compact so a string of failed tool calls stays
          // readable.
          className={styles.toolCallError}
        >
          {errorMessage}
        </p>
      )}
    </>
  )
}

function formatToolCallType(actionType: string): string {
  return actionType.replace(/^mcp__instatic__/, '')
}

/** Compact one-line summary of an applyCss payload: the selectors it touches. */
function summarizeCss(css: string): string {
  const selectors = css
    .match(/[^{}]+(?=\{)/g)
    ?.map((s) => s.trim().replace(/\s+/g, ' '))
    .filter(Boolean) ?? []
  if (selectors.length === 0) return 'css'
  const head = selectors.slice(0, 2).join(', ')
  return selectors.length > 2 ? `${head} +${selectors.length - 2}` : head
}

function formatActionLabel(actionType: string, params: unknown): string {
  const p = params as Record<string, unknown>
  switch (actionType) {
    case 'site_insert_html': return `→ ${String(p.parentId ?? '').slice(0, 8)}`
    case 'site_get_node_html': return `node ${String(p.nodeId ?? '').slice(0, 6)}…`
    case 'site_replace_node_html': return `node ${String(p.nodeId ?? '').slice(0, 6)}…`
    case 'site_delete_node': return `node ${String(p.nodeId ?? '').slice(0, 6)}…`
    case 'site_update_node_props': return `node ${String(p.nodeId ?? '').slice(0, 6)}…`
    case 'site_move_node': return `→ ${String(p.newParentId ?? '').slice(0, 6)}…`
    case 'site_rename_node': return `"${String(p.label ?? '')}"`
    case 'site_apply_css': return summarizeCss(String(p.css ?? ''))
    case 'site_assign_class': return `${String(p.classId ?? '').slice(0, 6)}… → node`
    case 'site_remove_class': return `${String(p.classId ?? '').slice(0, 6)}… from node`
    case 'site_add_page': return `"${String(p.title ?? '')}"`
    default: return ''
  }
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

type ComposerLockReason = 'setup' | 'chooseModel'

function AgentEmptyState({ mode }: { mode: ComposerLockReason | 'prompt' }) {
  if (mode === 'setup') {
    return (
      <EmptyState
        variant="centered"
        size="large"
        role="alert"
        icon={<AiSettingsSolidIcon size={34} />}
        title="Connect an AI provider"
        description="Add a provider credential, then choose a default model before starting a chat."
        action={<AgentSettingsButton variant="emptyState" label="Open AI settings" />}
      />
    )
  }

  if (mode === 'chooseModel') {
    return (
      <EmptyState
        variant="centered"
        size="large"
        role="alert"
        icon={<AiSettingsSolidIcon size={34} />}
        title="Choose a model to get started"
        description="Pick a model below, or set a default in AI settings so it's ready every time you open this chat."
        action={<AgentSettingsButton variant="emptyState" label="Set a default in AI settings" />}
      />
    )
  }

  return (
    <EmptyState
      variant="centered"
      size="large"
      icon={<AiBoxSolidIcon size={28} color="var(--text-disabled)" />}
      title="Describe what you want to build and I'll do it for you."
      description={'Try: "Add a hero section with a heading and button"'}
    />
  )
}

function AgentCredentialAlert({ mode }: { mode: ComposerLockReason }) {
  return (
    <div role="alert" className={styles.credentialAlert}>
      <p className={styles.credentialAlertText}>
        {mode === 'setup'
          ? 'No AI provider credentials are configured yet.'
          : 'Choose a model below, or set a default in AI settings.'}
      </p>
      <AgentSettingsButton
        variant="inline"
        label={mode === 'setup' ? 'Open AI settings' : 'Set a default'}
      />
    </div>
  )
}

function AgentSettingsButton({
  variant,
  label,
  'data-testid': testId,
}: {
  variant: 'header' | 'emptyState' | 'inline'
  label: string
  'data-testid'?: string
}) {
  const navigate = useAdminNavigate()

  function openAiSettings() {
    navigate(AI_SETTINGS_ROUTE)
  }

  if (variant === 'header') {
    return (
      <Button
        type="button"
        variant="ghost"
        size="xs"
        iconOnly
        onClick={openAiSettings}
        tooltip={label}
        aria-label={label}
        data-testid={testId}
        className={styles.credentialSettingsButtonHeader}
      >
        <AiSettingsSolidIcon size={14} aria-hidden="true" />
      </Button>
    )
  }

  return (
    <Button
      type="button"
      variant="secondary"
      size={variant === 'emptyState' ? 'md' : 'sm'}
      onClick={openAiSettings}
      aria-label={label}
      data-testid={testId}
      className={cn(
        styles.credentialSettingsButton,
        variant === 'emptyState' && styles.credentialSettingsButtonEmptyState,
        variant === 'inline' && styles.credentialSettingsButtonInline,
      )}
    >
      <AiSettingsSolidIcon size={14} aria-hidden="true" />
      <span>{label}</span>
      <ArrowRightIcon size={12} aria-hidden="true" />
    </Button>
  )
}
