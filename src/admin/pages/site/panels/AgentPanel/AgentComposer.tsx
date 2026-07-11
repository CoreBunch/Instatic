import { useEffect, useRef, useState } from 'react'
import { useAgentStore } from '@admin/ai/useAgentStore'
import { useAsyncResource } from '@admin/lib/useAsyncResource'
import { listModels, type CredentialView } from '@admin/ai/api'
import type { AiUserContentBlock } from '@core/ai'
import { Button } from '@ui/components/Button'
import { Textarea } from '@ui/components/Input'
import { pushToast } from '@ui/components/Toast'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import { SendSolidIcon } from 'pixel-art-icons/icons/send-solid'
import { SquareSolidIcon } from 'pixel-art-icons/icons/square-solid'
import { ContextMeter } from './ContextMeter'
import { ModelPicker } from './ModelPicker'
import { usePendingImageAttachment } from './usePendingImageAttachment'
import styles from './AgentPanel.module.css'

export type ComposerLockReason = 'setup' | 'chooseModel'

interface AgentComposerProps {
  composerLocked: boolean
  lockReason: ComposerLockReason | null
  credentials: CredentialView[]
  credentialsLoaded: boolean
  onRefreshCredentials(): void
}

export function AgentComposer({
  composerLocked,
  lockReason,
  credentials,
  credentialsLoaded,
  onRefreshCredentials,
}: AgentComposerProps) {
  const isStreaming = useAgentStore((state) => state.isAgentStreaming)
  const conversationPending = useAgentStore((state) => state.isAgentConversationPending)
  const providerPending = useAgentStore((state) => state.isAgentProviderPending)
  const isOpen = useAgentStore((state) => state.isAgentOpen)
  const sendAgentMessage = useAgentStore((state) => state.sendAgentMessage)
  const abortAgent = useAgentStore((state) => state.abortAgent)
  const activeCredentialId = useAgentStore((state) => state.agentActiveCredentialId)
  const activeModelId = useAgentStore((state) => state.agentActiveModelId)
  const [draft, setDraft] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const attachment = usePendingImageAttachment()
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!isOpen) return
    const id = setTimeout(() => inputRef.current?.focus(), 50)
    return () => clearTimeout(id)
  }, [isOpen])

  const activeProviderId =
    credentials.find((credential) => credential.id === activeCredentialId)?.providerId ?? null
  const activeModelResource = useAsyncResource(
    async () => {
      if (!activeProviderId || !activeCredentialId || !activeModelId) return null
      const models = await listModels(activeProviderId, activeCredentialId)
      return {
        credentialId: activeCredentialId,
        modelId: activeModelId,
        model: models.find((model) => model.id === activeModelId) ?? null,
      }
    },
    [activeProviderId, activeCredentialId, activeModelId],
    { fallbackError: 'Could not verify image support for this model.' },
  )
  const resolvedSelection = activeModelResource.data
  const activeModel =
    resolvedSelection?.credentialId === activeCredentialId
    && resolvedSelection.modelId === activeModelId
      ? resolvedSelection.model
      : null
  const modelCannotRunAgent = activeModel?.capabilities.toolCalling === false

  const imageStatus = !attachment.pending
    ? 'none'
    : attachment.pending.status === 'processing'
      ? 'processing'
      : attachment.pending.status === 'error'
        ? 'error'
        : activeModelResource.loading
          ? 'checking-model'
          : activeModelResource.error || !resolvedSelection
            ? 'model-error'
          : activeModel?.capabilities.visionInput
            ? 'ready'
            : 'unsupported-model'

  async function submit(): Promise<void> {
    if (
      isStreaming
      || conversationPending
      || providerPending
      || submitting
      || modelCannotRunAgent
    ) return
    const text = draft.trim()
    const pending = attachment.current()
    if (!text && !pending) return
    if (pending?.status === 'processing') {
      pushToast({ kind: 'error', title: 'Image is still processing', body: 'Wait a moment, then send again.' })
      return
    }
    if (pending?.status === 'error' || (pending && !pending.block)) return
    if (pending && imageStatus !== 'ready') return

    const content: AiUserContentBlock[] = []
    if (text) content.push({ kind: 'text', text })
    if (pending?.block) content.push(pending.block)

    setSubmitting(true)
    try {
      const result = await sendAgentMessage(content)
      if (result.accepted) {
        setDraft('')
        attachment.clear()
      }
    } finally {
      setSubmitting(false)
    }
  }

  function handlePaste(event: React.ClipboardEvent<HTMLTextAreaElement>): void {
    const imageFiles = Array.from(event.clipboardData.files).filter((file) =>
      file.type.startsWith('image/'),
    )
    if (imageFiles.length === 0) return
    event.preventDefault()
    attachment.queueFile(imageFiles[0]!)
    if (imageFiles.length > 1) {
      pushToast({
        kind: 'error',
        title: 'One image per message',
        body: 'Only the first pasted image was attached.',
      })
    }
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key !== 'Enter' || event.shiftKey) return
    event.preventDefault()
    void submit()
  }

  const imageBlocksSend = imageStatus !== 'none' && imageStatus !== 'ready'
  const sendDisabled =
    composerLocked
    || conversationPending
    || providerPending
    || submitting
    || imageBlocksSend
    || modelCannotRunAgent
  let sendTooltip = 'Send'
  if (lockReason === 'setup') sendTooltip = 'Add AI credentials first'
  else if (lockReason === 'chooseModel') sendTooltip = 'Choose a model first'
  else if (modelCannotRunAgent) sendTooltip = 'Choose an agent-capable model'
  else if (imageStatus === 'processing') sendTooltip = 'Preparing image'
  else if (imageStatus === 'checking-model') sendTooltip = 'Checking image support'
  else if (imageStatus === 'model-error') sendTooltip = 'Could not verify image support'
  else if (imageStatus === 'unsupported-model') sendTooltip = 'Choose a vision-capable model'
  else if (imageStatus === 'error') sendTooltip = 'Remove the failed image'

  return (
    <div className={styles.inputBar}>
      <ContextMeter windowTokens={activeModel?.contextWindow ?? null} />
      {attachment.pending && (
        <div
          className={styles.attachmentCard}
          role="group"
          aria-label={`Attached image: ${attachment.pending.filename}`}
          aria-busy={attachment.pending.status === 'processing'}
        >
          {attachment.pending.previewUrl ? (
            <img
              src={attachment.pending.previewUrl}
              alt=""
              className={styles.attachmentPreview}
            />
          ) : (
            <div className={styles.attachmentPreviewPlaceholder} aria-hidden="true" />
          )}
          <div className={styles.attachmentCopy}>
            <span className={styles.attachmentName}>{attachment.pending.filename}</span>
            <span
              className={styles.attachmentStatus}
              role="status"
              aria-live="polite"
            >
              {attachment.pending.status === 'processing'
                ? 'Preparing…'
                : attachment.pending.status === 'error'
                  ? attachment.pending.error
                  : 'Ready'}
            </span>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            iconOnly
            disabled={submitting || isStreaming}
            onClick={attachment.remove}
            tooltip="Remove image"
            aria-label="Remove attached image"
            className={styles.attachmentRemove}
          >
            <CloseIcon size={12} aria-hidden="true" />
          </Button>
        </div>
      )}
      {attachment.pending && imageStatus === 'checking-model' && (
        <p role="status" className={styles.attachmentNotice}>Checking whether this model accepts images…</p>
      )}
      {attachment.pending && imageStatus === 'unsupported-model' && (
        <p role="alert" className={styles.attachmentWarning}>
          Choose a vision-capable model or remove the image.
        </p>
      )}
      {attachment.pending && imageStatus === 'model-error' && (
        <p role="alert" className={styles.attachmentWarning}>
          Could not verify image support for this model. Choose another model or remove the image.
        </p>
      )}
      {modelCannotRunAgent && (
        <p role="alert" className={styles.attachmentWarning}>
          Choose an agent-capable model that supports tool calling.
        </p>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
        className={styles.inputForm}
      >
        {!isStreaming && (
          <Textarea
            ref={inputRef}
            value={draft}
            placeholder={lockReason === 'setup'
              ? 'Add AI credentials to start chatting'
              : lockReason === 'chooseModel'
                ? 'Choose a model below to start'
                : 'Tell me what to build… (paste an image or press Enter to send)'}
            aria-label="Message to AI assistant"
            rows={2}
            resize="none"
            disabled={composerLocked || conversationPending || providerPending || submitting}
            onPaste={handlePaste}
            onKeyDown={handleKeyDown}
            onChange={(event) => {
              setDraft(event.target.value)
              event.target.style.height = 'auto'
              event.target.style.height = `${Math.min(event.target.scrollHeight, 120)}px`
            }}
          />
        )}
        <div className={styles.inputControls}>
          <ModelPicker
            className={styles.inputControlsPicker}
            credentials={credentials}
            credentialsLoaded={credentialsLoaded}
            onRefreshCredentials={onRefreshCredentials}
            disabled={isStreaming || conversationPending || providerPending || submitting}
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
              disabled={sendDisabled}
              tooltip={sendTooltip}
              aria-label="Send"
            >
              <SendSolidIcon size={14} />
            </Button>
          )}
        </div>
      </form>
    </div>
  )
}
