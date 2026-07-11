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
import { useAgentStore, useAgentStoreApi } from '@admin/ai/useAgentStore'
import { useAsyncResource } from '@admin/lib/useAsyncResource'
import { useAdminNavigate } from '@admin/lib/useAdminNavigate'
import { useAuthenticatedAdminUser } from '@admin/sessionContext'
import { listCredentials } from '@admin/ai/api'
import { renderMarkdownToHtml, type AgentMessage, type AgentToolCall } from '@site/agent'
import { AiBoxSolidIcon } from 'pixel-art-icons/icons/ai-box-solid'
import { AiSettingsSolidIcon } from 'pixel-art-icons/icons/ai-settings-solid'
import { EditSolidIcon } from 'pixel-art-icons/icons/edit-solid'
import { ArrowRightIcon } from 'pixel-art-icons/icons/arrow-right'
import { PanelHeader } from '@admin/shared/PanelHeader'
import { UserAvatar } from '@admin/shared/UserAvatar'
import { Button } from '@ui/components/Button'
import { EmptyState } from '@ui/components/EmptyState'
import { useDraggablePanel } from '@admin/shared/FloatingWindow'
import { cn } from '@ui/cn'
import { ConversationHistory } from './ConversationHistory'
import { AgentComposer, type ComposerLockReason } from './AgentComposer'
import {
  AgentImageGallery,
} from './AgentImageGallery'
import { AgentImageContextMenu } from './AgentImageContextMenu'
import { AgentImagePreview } from './AgentImagePreview'
import type {
  AgentImageMenuRequest,
  AgentPreviewImage,
  OpenAgentImageMenu,
} from './agentImageTypes'
import { ToolCallRow } from './ToolCallRow'
import { formatRelativeTime } from './relativeTime'
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
  const agentStore = useAgentStoreApi()
  const isOpen = useAgentStore((s) => s.isAgentOpen)
  const isStreaming = useAgentStore((s) => s.isAgentStreaming)
  const conversationPending = useAgentStore((s) => s.isAgentConversationPending)
  const providerPending = useAgentStore((s) => s.isAgentProviderPending)
  const messages = useAgentStore((s) => s.agentMessages)
  const agentError = useAgentStore((s) => s.agentError)
  const closeAgent = useAgentStore((s) => s.closeAgent)
  const startNewAgentConversation = useAgentStore((s) => s.startNewAgentConversation)
  const loadScopeDefault = useAgentStore((s) => s.loadScopeDefault)
  const composerEpoch = useAgentStore((s) => s.agentComposerEpoch)
  const activeCredentialId = useAgentStore((s) => s.agentActiveCredentialId)
  const activeModelId = useAgentStore((s) => s.agentActiveModelId)
  const [previewImage, setPreviewImage] = useState<AgentPreviewImage | null>(null)
  const [imageMenu, setImageMenu] = useState<AgentImageMenuRequest | null>(null)
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
  const lockReason: ComposerLockReason | null = !composerLocked
    ? null
    : noCredentials
      ? 'setup'
      : credentialsLoaded
        ? 'chooseModel'
        : null

  const threadRef = useRef<HTMLDivElement>(null)

  // ── Draggable panel position ───────────────────────────────────────────────
  // Default to bottom-right corner.
  const { setPanelRef, headerDragProps, panelPositionStyle } = useDraggablePanel(
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

  // Preload the per-scope default credential + model when the panel opens, so
  // the picker shows the configured default immediately and the first send
  // uses it. The action no-ops if a conversation or explicit pick already
  // exists, so re-opens are cheap.
  useEffect(() => {
    if (isOpen) void loadScopeDefault()
  }, [isOpen, loadScopeDefault])

  useEffect(() => agentStore.subscribe((state, previous) => {
    if (
      (previous.isAgentOpen && !state.isAgentOpen)
      || previous.agentComposerEpoch !== state.agentComposerEpoch
    ) {
      setPreviewImage(null)
      setImageMenu(null)
    }
  }), [agentStore])

  function openImageMenu(request: AgentImageMenuRequest): void {
    setImageMenu(request)
  }

  function openImagePreview(image: AgentPreviewImage): void {
    setImageMenu(null)
    setPreviewImage(image)
  }

  function closeImageMenu(): void {
    const returnFocus = imageMenu?.returnFocus
    setImageMenu(null)
    if (returnFocus?.isConnected) {
      requestAnimationFrame(() => returnFocus.focus())
    }
  }

  function closeImagePreview(): void {
    setPreviewImage(null)
    setImageMenu(null)
  }

  // Escape key — close the AI panel
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || imageMenu !== null) return
      if (e.key === 'Escape' && isOpen) {
        e.preventDefault()
        closeAgent()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [isOpen, imageMenu, closeAgent])

  // Always-mounted: CSS display:none when closed (via .floatPanelClosed) preserves
  // Zustand state across open/close cycles without conditional rendering.
  return (
    <aside
      ref={setPanelRef}
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
          disabled={isStreaming || conversationPending || providerPending}
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
              <MessageBubble
                key={group.id}
                group={group}
                onOpenImage={openImagePreview}
                onOpenImageMenu={openImageMenu}
              />
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

      <AgentComposer
        key={composerEpoch}
        composerLocked={composerLocked}
        lockReason={lockReason}
        credentials={credentials}
        credentialsLoaded={credentialsLoaded}
        onRefreshCredentials={credentialsResource.refresh}
        onOpenImage={openImagePreview}
        onOpenImageMenu={openImageMenu}
      />
    </div>
      <AgentImagePreview
        image={isOpen ? previewImage : null}
        imageMenuOpen={imageMenu !== null}
        onOpenImageMenu={openImageMenu}
        onClose={closeImagePreview}
      />
      {isOpen && imageMenu && (
        <AgentImageContextMenu request={imageMenu} onClose={closeImageMenu} />
      )}
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

function MessageBubble({
  group,
  onOpenImage,
  onOpenImageMenu,
}: {
  group: ConversationGroup
  onOpenImage(image: AgentPreviewImage): void
  onOpenImageMenu: OpenAgentImageMenu
}) {
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
        ) : item.kind === 'images' ? (
          <MessageImageGallery
            key={item.key}
            images={item.images}
            isUser={isUser}
            onOpenImage={onOpenImage}
            onOpenImageMenu={onOpenImageMenu}
          />
        ) : (
          // A run of consecutive tool calls shares one container so the rows
          // stack tightly; text blocks around them stay separate bubbles.
          <div key={item.key} className={styles.toolCallsContainer}>
            {item.toolCalls.map((toolCall) => (
              <ToolCallRow key={toolCall.id} toolCall={toolCall} />
            ))}
            <ToolPreviewGallery
              toolCalls={item.toolCalls}
              onOpenImage={onOpenImage}
              onOpenImageMenu={onOpenImageMenu}
            />
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
  | {
      kind: 'images'
      key: string
      images: Array<{ key: string; src: string }>
    }
  | { kind: 'tools'; key: string; toolCalls: AgentToolCall[] }

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
        const image = {
          key: `image-${message.id}-${index}`,
          src: block.src,
        }
        const last = items.at(-1)
        if (last?.kind === 'images') last.images.push(image)
        else items.push({ kind: 'images', key: image.key, images: [image] })
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

function MessageImageGallery({
  images,
  isUser,
  onOpenImage,
  onOpenImageMenu,
}: {
  images: Array<{ key: string; src: string }>
  isUser: boolean
  onOpenImage(image: AgentPreviewImage): void
  onOpenImageMenu: OpenAgentImageMenu
}) {
  const galleryImages = images.map((image, index): AgentPreviewImage => ({
    id: image.key,
    src: image.src,
    alt: images.length === 1
      ? isUser ? 'Attachment from you' : 'Image from assistant'
      : isUser
        ? `Attachment ${index + 1} of ${images.length} from you`
        : `Image ${index + 1} of ${images.length} from assistant`,
    title: isUser ? 'Your attachment' : 'Assistant image',
    filename: isUser
      ? `your-attachment-${index + 1}`
      : `assistant-image-${index + 1}`,
  }))

  return (
    <AgentImageGallery
      images={galleryImages}
      label={isUser ? 'Images from you' : 'Images from assistant'}
      onOpenImage={onOpenImage}
      onOpenImageMenu={onOpenImageMenu}
    />
  )
}

function ToolPreviewGallery({
  toolCalls,
  onOpenImage,
  onOpenImageMenu,
}: {
  toolCalls: AgentToolCall[]
  onOpenImage(image: AgentPreviewImage): void
  onOpenImageMenu: OpenAgentImageMenu
}) {
  const images = toolCalls.flatMap((toolCall) =>
    (toolCall.previewImages ?? []).map((src, index): AgentPreviewImage => ({
      id: `${toolCall.id}-preview-${index}`,
      src,
      alt: `Image ${index + 1} captured while running ${toolCall.actionType}`,
      title: 'Tool result image',
      filename: `${toolCall.actionType}-${index + 1}`,
    })),
  )
  return (
    <AgentImageGallery
      images={images}
      label="Images captured by assistant tools"
      onOpenImage={onOpenImage}
      onOpenImageMenu={onOpenImageMenu}
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
