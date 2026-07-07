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

import { useRef, useEffect, useState, memo } from 'react'
import { useAgentStore } from '@admin/ai/useAgentStore'
import { useAsyncResource } from '@admin/lib/useAsyncResource'
import { useAdminNavigate } from '@admin/lib/useAdminNavigate'
import { useAuthenticatedAdminUser } from '@admin/sessionContext'
import { listCredentials, listModels } from '@admin/ai/api'
import { renderMarkdownToHtml, type AgentImageAttachment, type AgentMessage, type AgentToolCall } from '@site/agent'
import { SquareSolidIcon } from 'pixel-art-icons/icons/square-solid'
import { SendSolidIcon } from 'pixel-art-icons/icons/send-solid'
import { AiBoxSolidIcon } from 'pixel-art-icons/icons/ai-box-solid'
import { AiSettingsSolidIcon } from 'pixel-art-icons/icons/ai-settings-solid'
import { EditSolidIcon } from 'pixel-art-icons/icons/edit-solid'
import { ArrowRightIcon } from 'pixel-art-icons/icons/arrow-right'
import { PanelHeader } from '@admin/shared/PanelHeader'
import { UserAvatar } from '@admin/shared/UserAvatar'
import { Button } from '@ui/components/Button'
import { pushToast } from '@ui/components/Toast'
import { EmptyState } from '@ui/components/EmptyState'
import { Textarea } from '@ui/components/Input'
import { useDraggablePanel } from '@site/hooks/useDraggablePanel'
import { cn } from '@ui/cn'
import { ModelPicker } from './ModelPicker'
import { ConversationHistory } from './ConversationHistory'
import { ContextMeter } from './ContextMeter'
import { ToolCallRow } from './ToolCallRow'
import { formatRelativeTime } from './relativeTime'
import styles from './AgentPanel.module.css'

const PANEL_WIDTH = 320
const PANEL_HEIGHT = 480
const AI_SETTINGS_ROUTE = '/admin/ai'
type PanelVariant = 'floating' | 'docked'

// Pasted-image constraints (mirrored server-side in chat.ts): allow-list of
// MIME types and a ~10MB-per-image base64 budget.
const ALLOWED_IMAGE_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
const MAX_IMAGE_BYTES = 10 * 1024 * 1024

/** Read a File as a `data:<mime>;base64,<data>` data URL. */
function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

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

  // Pasted image attachments awaiting send. Cleared after the message is sent.
  const [pendingImages, setPendingImages] = useState<AgentImageAttachment[]>([])

  // Active model's vision capability (null until a model is picked). Used to
  // soft-warn when images are attached but the model can't actually see them.
  const activeModelVisionResource = useAsyncResource(
    async () => {
      if (!activeProviderId || !activeCredentialId || !activeModelId) return null
      const models = await listModels(activeProviderId, activeCredentialId)
      return models.find((m) => m.id === activeModelId)?.capabilities.visionInput ?? null
    },
    [activeProviderId, activeCredentialId, activeModelId],
    { swallowErrors: true },
  )
  const activeModelVision = activeModelVisionResource.data

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
    // Allow image-only sends; require at least text or an image.
    if ((!content && pendingImages.length === 0) || isStreaming) return
    input.value = ''
    input.style.height = 'auto'
    const images = pendingImages
    setPendingImages([])
    await sendAgentMessage(content, images)
  }

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const imageFiles = Array.from(e.clipboardData.files ?? []).filter((f) =>
      f.type.startsWith('image/'),
    )
    if (imageFiles.length === 0) return
    e.preventDefault()
    void Promise.all(
      imageFiles.map(async (file) => {
        if (!ALLOWED_IMAGE_MIME.includes(file.type)) {
          pushToast({
            kind: 'error',
            title: 'Unsupported image',
            body: `${file.type || 'Unknown type'} is not supported. Use PNG, JPEG, WebP, or GIF.`,
          })
          return
        }
        if (file.size > MAX_IMAGE_BYTES) {
          pushToast({ kind: 'error', title: 'Image too large', body: 'Images must be under 10MB.' })
          return
        }
        const dataUrl = await readFileAsDataUrl(file)
        const match = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl)
        if (!match) return
        const [, mimeType, data] = match
        setPendingImages((prev) => [...prev, { mimeType, data }])
      }),
    )
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
            {groupConsecutiveMessages(messages).map((group) => (
              <MessageBubble key={group.id} group={group} />
            ))}
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
        {/* Attachment tray — thumbnails of pasted images awaiting send, with
            remove buttons. Rendered above the composer so it's visible before
            the user types/sends. */}
        {pendingImages.length > 0 && (
          <div className={styles.attachmentTray} aria-label="Attached images">
            {pendingImages.map((img, i) => (
              <div key={i} className={styles.attachmentThumb}>
                <img
                  src={`data:${img.mimeType};base64,${img.data}`}
                  alt={`Attachment ${i + 1}`}
                  className={styles.attachmentThumbImg}
                />
                <button
                  type="button"
                  className={styles.attachmentRemove}
                  aria-label="Remove attachment"
                  onClick={() =>
                    setPendingImages((prev) => prev.filter((_, idx) => idx !== i))
                  }
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        {/* Soft warning: images attached but the active model can't see them. */}
        {pendingImages.length > 0 && activeModelVision === false && (
          <p role="status" className={styles.visionWarning}>
            This model can&apos;t see images — they&apos;ll be sent but ignored.
          </p>
        )}
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
              onPaste={handlePaste}
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

interface ConversationGroup {
  id: string
  role: AgentMessage['role']
  messages: AgentMessage[]
}

function MessageBubble({ group }: { group: ConversationGroup }) {
  const isUser = group.role === 'user'
  const user = useAuthenticatedAdminUser()
  const startedAt = group.messages[0]?.timestamp
  const relativeTime = startedAt ? formatRelativeTime(startedAt) : ''

  return (
    <div className={styles.messageTurn}>
      {/* Role marker — avatar + name + relative time, once per turn. The user
          reuses their Gravatar; the agent gets the robot glyph. */}
      <div className={styles.roleLabel}>
        {isUser ? (
          <UserAvatar user={user} size={16} alt={null} />
        ) : (
          <span className={styles.roleAvatarAi} aria-hidden="true">
            <AiBoxSolidIcon size={11} />
          </span>
        )}
        <span className={styles.roleName}>{isUser ? 'You' : 'Assistant'}</span>
        {relativeTime && <span className={styles.roleTime}>· {relativeTime}</span>}
      </div>

      {/* Chronological blocks — text and tool calls render in the order
          Claude actually emitted them, so a "text → tool → text" sequence
          shows two separate text bubbles around the tool badges. Text is
          rendered as markdown (bold, lists, inline code, links, …) via a
          DOMPurify-sanitised HTML pipeline. */}
      {groupRenderItems(group.messages).map((item) =>
        item.kind === 'text' ? (
          <MarkdownTextBubble key={item.key} text={item.text} isUser={isUser} />
        ) : item.kind === 'image' ? (
          <UserImageBubble key={item.key} mimeType={item.mimeType} data={item.data} />
        ) : (
          // A run of consecutive tool calls shares one container so the rows
          // stack tightly; text blocks around them stay separate bubbles.
          <div key={item.key} className={styles.toolCallsContainer}>
            {item.toolCalls.map((toolCall) => (
              <ToolCallRow key={toolCall.id} toolCall={toolCall} />
            ))}
          </div>
        ),
      )}
    </div>
  )
}

// Collapse the flat message list into conversational turns: consecutive
// messages of the same role become one group (one bubble, one role label).
// The agent emits each tool call as its own message, so without this a burst
// of tool activity would render as a stack of repeated "Assistant" labels.
function groupConsecutiveMessages(messages: AgentMessage[]): ConversationGroup[] {
  const groups: ConversationGroup[] = []
  for (const message of messages) {
    const last = groups.at(-1)
    if (last && last.role === message.role) {
      last.messages.push(message)
      continue
    }
    groups.push({ id: message.id, role: message.role, messages: [message] })
  }
  return groups
}

// Flatten a turn's blocks (across its messages) in emission order, coalescing
// each run of consecutive tool-call blocks into one item so they render inside
// a single tight container; text blocks stay separate bubbles.
type MessageBlock = AgentMessage['blocks'][number]

type MessageRenderItem =
  | { kind: 'text'; key: string; text: string }
  | { kind: 'tools'; key: string; toolCalls: AgentToolCall[] }
  | { kind: 'image'; key: string; mimeType: string; data: string }

function groupRenderItems(messages: AgentMessage[]): MessageRenderItem[] {
  const items: MessageRenderItem[] = []
  for (const message of messages) {
    message.blocks.forEach((block: MessageBlock, index) => {
      if (block.kind === 'text') {
        // Position-based key, stable as streaming deltas append in place.
        items.push({ kind: 'text', key: `text-${message.id}-${index}`, text: block.text })
        return
      }
      if (block.kind === 'image') {
        items.push({
          kind: 'image',
          key: `image-${message.id}-${index}`,
          mimeType: block.mimeType,
          data: block.data,
        })
        return
      }
      const last = items.at(-1)
      if (last && last.kind === 'tools') {
        last.toolCalls.push(block.toolCall)
        return
      }
      items.push({ kind: 'tools', key: `tools-${block.toolCall.id}`, toolCalls: [block.toolCall] })
    })
  }
  return items
}

// Renders a user-pasted image attachment as a thumbnail in the thread.
function UserImageBubble({ mimeType, data }: { mimeType: string; data: string }) {
  return (
    <img
      src={`data:${mimeType};base64,${data}`}
      alt="Attached image"
      className={styles.userImage}
    />
  )
}

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
        styles.messageText,
        isUser ? styles.messageTextUser : styles.messageTextAssistant,
        styles.markdownText,
      )}
      // Safe: sanitised by DOMPurify (via sanitizeRichtext) before reaching here.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
})

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
