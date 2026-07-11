/**
 * ConversationHistory — popover triggered by the chat-history button in
 * the AgentPanel header. Lists this user's site-scope conversations and
 * exposes load, delete, and "+ New" actions.
 *
 * Built on the shared `ContextMenu` primitive so positioning, dismiss
 * handling, and styling match the rest of the admin.
 */

import { useEffect, useRef, useState } from 'react'
import { useAgentStore } from '@admin/ai/useAgentStore'
import { Button } from '@ui/components/Button'
import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from '@ui/components/ContextMenu'
import { BulletlistSolidIcon } from 'pixel-art-icons/icons/bulletlist-solid'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { TrashSolidIcon } from 'pixel-art-icons/icons/trash-solid'
import { formatRelativeTime } from './relativeTime'
import styles from './AgentPanel.module.css'

export function ConversationHistory() {
  const conversations = useAgentStore((s) => s.agentConversations)
  const activeId = useAgentStore((s) => s.agentConversationId)
  const loadAgentConversations = useAgentStore((s) => s.loadAgentConversations)
  const loadAgentConversation = useAgentStore((s) => s.loadAgentConversation)
  const startNewAgentConversation = useAgentStore((s) => s.startNewAgentConversation)
  const deleteAgentConversation = useAgentStore((s) => s.deleteAgentConversation)
  const isStreaming = useAgentStore((s) => s.isAgentStreaming)
  const conversationPending = useAgentStore((s) => s.isAgentConversationPending)
  const providerPending = useAgentStore((s) => s.isAgentProviderPending)
  const controlsDisabled = isStreaming || conversationPending || providerPending

  const triggerRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)

  // Refresh the list every time the popover opens. Cheap query.
  useEffect(() => {
    if (!open) return
    void loadAgentConversations()
  }, [open, loadAgentConversations])

  return (
    <>
      <Button
        ref={triggerRef}
        type="button"
        variant="ghost"
        size="xs"
        iconOnly
        disabled={controlsDisabled}
        onClick={() => setOpen((v) => !v)}
        tooltip="Chat history"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Conversation history"
      >
        <BulletlistSolidIcon size={14} />
      </Button>
      {open && (
        <ContextMenu
          anchorRef={triggerRef}
          triggerRef={triggerRef}
          align="start"
          side="auto"
          offset={6}
          minWidth={260}
          maxHeight={360}
          ariaLabel="Conversation history"
          onClose={() => setOpen(false)}
        >
          <ContextMenuItem
            disabled={controlsDisabled}
            onClick={() => {
              startNewAgentConversation()
              setOpen(false)
            }}
          >
            <PlusIcon size={12} aria-hidden="true" />
            <span>New chat</span>
          </ContextMenuItem>
          <ContextMenuSeparator />
          {conversations.length === 0 ? (
            <ContextMenuItem disabled>
              <span>No chats yet.</span>
            </ContextMenuItem>
          ) : (
            conversations.map((conv) => {
              const isActive = conv.id === activeId
              return (
                <ContextMenuItem
                  key={conv.id}
                  role="menuitemradio"
                  aria-checked={isActive}
                  active={isActive}
                  disabled={controlsDisabled}
                  onClick={() => {
                    if (!isActive) void loadAgentConversation(conv.id)
                    setOpen(false)
                  }}
                >
                  <span className={styles.historyItemTitle}>{conv.title}</span>
                  <span className={styles.historyItemMeta}>
                    <span className={styles.historyItemTime}>
                      {formatRelativeTime(Date.parse(conv.updatedAt))}
                    </span>
                    {/* Span (not a native button) so it doesn't nest inside the
                        ContextMenuItem's Button — nested interactive
                        elements are invalid HTML + would trip BTN-3. */}
                    <span
                      role="button"
                      tabIndex={controlsDisabled ? -1 : 0}
                      aria-disabled={controlsDisabled}
                      className={styles.historyItemDelete}
                      aria-label={`Delete chat "${conv.title}"`}
                      onClick={(e) => {
                        e.stopPropagation()
                        if (controlsDisabled) return
                        void deleteAgentConversation(conv.id)
                      }}
                      onKeyDown={(e) => {
                        if (controlsDisabled) return
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          e.stopPropagation()
                          void deleteAgentConversation(conv.id)
                        }
                      }}
                    >
                      <TrashSolidIcon size={12} aria-hidden="true" />
                    </span>
                  </span>
                </ContextMenuItem>
              )
            })
          )}
        </ContextMenu>
      )}
    </>
  )
}
