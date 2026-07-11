/**
 * AgentPanel's model picker — a thin store-binding wrapper around the shared
 * {@link ModelPicker}. It maps the agent store's active `(credential, model)`
 * onto the picker's controlled `value`/`onChange` and renders the compact
 * `inline` trigger that fits the chat composer toolbar.
 */

import { useAgentStore } from '@admin/ai/useAgentStore'
import { ModelPicker as SharedModelPicker } from '@admin/ai/ModelPicker'
import type { CredentialView } from '@admin/ai/api'

interface ModelPickerProps {
  /** Optional extra className for the trigger wrapper. */
  className?: string
  /** Credentials are loaded by AgentPanel so header + thread state stay in sync. */
  credentials: CredentialView[]
  /** True once the credential list fetch has completed at least once. */
  credentialsLoaded: boolean
  /** Re-run the credential list query when the picker opens. */
  onRefreshCredentials: () => void
  disabled?: boolean
}

export function ModelPicker({
  className,
  credentials,
  credentialsLoaded,
  onRefreshCredentials,
  disabled = false,
}: ModelPickerProps) {
  const activeCredentialId = useAgentStore((s) => s.agentActiveCredentialId)
  const activeModelId = useAgentStore((s) => s.agentActiveModelId)
  const setAgentProvider = useAgentStore((s) => s.setAgentProvider)

  const value =
    activeCredentialId && activeModelId
      ? { credentialId: activeCredentialId, modelId: activeModelId }
      : null

  return (
    <SharedModelPicker
      className={className}
      variant="inline"
      placeholder="Choose a model"
      credentials={credentials}
      credentialsLoaded={credentialsLoaded}
      disabled={disabled}
      value={value}
      onOpen={onRefreshCredentials}
      onChange={({ credentialId, modelId }) => void setAgentProvider(credentialId, modelId)}
    />
  )
}
