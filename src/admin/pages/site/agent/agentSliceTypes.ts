import type { EditorStoreSliceCreator } from '@site/store/types'
import type { AiToolOutput, AiUserContentBlock } from '@core/ai'
import type { ConversationView } from '@admin/ai/api'
import type { AgentMessage, AgentToolScope } from './types'

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

export interface AgentSlice {
  isAgentOpen: boolean
  isAgentStreaming: boolean
  agentMessages: AgentMessage[]
  agentError: string | null
  agentConversationId: string | null
  agentActiveCredentialId: string | null
  agentActiveModelId: string | null
  agentConversations: ConversationView[]
  agentContextTokens: number | null
  /** True while a history load/delete can replace the active conversation. */
  isAgentConversationPending: boolean
  /** True while an existing conversation's provider/model update is pending. */
  isAgentProviderPending: boolean
  /** Remounts local composer drafts on explicit conversation replacement. */
  agentComposerEpoch: number

  openAgent(): void
  closeAgent(): void
  toggleAgent(): void
  sendAgentMessage(content: AiUserContentBlock[]): Promise<{ accepted: boolean }>
  abortAgent(): void
  clearAgentMessages(): void
  loadAgentConversations(): Promise<void>
  loadAgentConversation(id: string): Promise<void>
  startNewAgentConversation(): void
  deleteAgentConversation(id: string): Promise<void>
  setAgentProvider(credentialId: string, modelId: string): Promise<void>
  loadScopeDefault(): Promise<void>
}

export type EditorStoreSet = Parameters<EditorStoreSliceCreator<AgentSlice>>[0]
export type AgentSliceGet = Parameters<EditorStoreSliceCreator<AgentSlice>>[1]
