import type { EditorStoreSliceCreator } from '@site/store/types'
import type { AiToolOutput, AiUserContentBlock } from '@core/ai'
import type { ConversationView } from '@admin/ai/api'
import type { AgentMessage, AgentMessageMention, AgentToolScope } from './types'

export interface AgentSliceConfig {
  /**
   * Conversation scope. Used in URL paths (`/admin/api/ai/chat/${scope}`,
   * `?scope=${scope}`), conversation-create body, and the per-scope default
   * lookup. Keep it aligned with `server/ai/runtime/types.ts → ToolScope`.
   */
  readonly scope: AgentToolScope
  /**
   * Build the per-request snapshot. The slice has no knowledge of the host
   * store's shape; the config closure pulls from whatever store the host
   * mounted the agent in.
   */
  buildSnapshot(): unknown
  /**
   * Dispatch a write-tool request. The slice forwards the server's
   * `toolRequest` event to this function and POSTs the result back.
   */
  dispatchTool(toolName: string, input: unknown): Promise<AiToolOutput>
  /**
   * Optional copy override for the "no AI provider configured" error so
   * each scope can point the user at the right /admin/ai page.
   */
  readonly noProviderMessage?: string
}

/**
 * Usage attached to the active conversation.
 *
 * `contextTokens` is the latest provider round's input size, while the other
 * fields are cumulative billing totals across every round in the conversation.
 * Keeping both in one snapshot makes that distinction explicit at call sites.
 */
export interface AgentConversationUsage {
  contextTokens: number | null
  /** Selection that produced `contextTokens`; null until the first measured round. */
  contextCredentialId: string | null
  contextModelId: string | null
  promptTokens: number
  completionTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  costUsd: number
}

export interface AgentDraftMention {
  nodeId: string
  label: string
}

export interface AgentSlice {
  isAgentOpen: boolean
  isAgentStreaming: boolean
  agentMessages: AgentMessage[]
  agentError: string | null
  agentConversationId: string | null
  agentActiveCredentialId: string | null
  agentActiveModelId: string | null
  agentConversations: ConversationView[]
  agentUsage: AgentConversationUsage
  /** True while a history load/delete can replace the active conversation. */
  isAgentConversationPending: boolean
  /** True while an existing conversation's provider/model update is pending. */
  isAgentProviderPending: boolean
  /** Remounts local composer drafts on explicit conversation replacement. */
  agentComposerEpoch: number
  /**
   * Mention queue for the agent composer. Set by "Add to AI Chat" actions
   * from the canvas / layers panel; consumed once by AgentComposer then
   * cleared. Each entry carries the layer's nodeId and display label.
   */
  agentDraftMentions: AgentDraftMention[]
  /**
   * Accumulated nodeId → human label registry across the conversation.
   * Survives node deletion so scanned assistant mentions can still be
   * rendered as clickable pills with friendly names after a node is gone.
   */
  agentMentionLabels: Record<string, string>

  openAgent(): void
  closeAgent(): void
  toggleAgent(): void
  sendAgentMessage(
    content: AiUserContentBlock[],
    mentions?: AgentMessageMention[],
  ): Promise<{ accepted: boolean }>
  abortAgent(): void
  clearAgentMessages(): void
  loadAgentConversations(): Promise<void>
  loadAgentConversation(id: string): Promise<void>
  startNewAgentConversation(): void
  deleteAgentConversation(id: string): Promise<void>
  setAgentProvider(credentialId: string, modelId: string): Promise<void>
  loadScopeDefault(): Promise<void>
  /**
   * Queue layer mentions into the agent composer and open the panel so the
   * user can finish their prompt. Used by "Add to AI Chat" flows.
   */
  stageAgentMentions(mentions: AgentDraftMention[]): void
  /**
   * Clear the mention queue after the composer has consumed it.
   */
  clearAgentDraftMentions(): void
}

export type EditorStoreSet = Parameters<EditorStoreSliceCreator<AgentSlice>>[0]
export type AgentSliceGet = Parameters<EditorStoreSliceCreator<AgentSlice>>[1]
