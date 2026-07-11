import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
} from 'react'
import { useAgentStore } from '@admin/ai/useAgentStore'
import { useAsyncResource } from '@admin/lib/useAsyncResource'
import { listModels, type CredentialView } from '@admin/ai/api'
import {
  AI_USER_IMAGE_MAX_PER_MESSAGE,
  type AiUserContentBlock,
} from '@core/ai'
import { Button } from '@ui/components/Button'
import { FileUpload } from '@ui/components/FileUpload'
import { Textarea } from '@ui/components/Input'
import { pushToast } from '@ui/components/Toast'
import { SendSolidIcon } from 'pixel-art-icons/icons/send-solid'
import { SquareSolidIcon } from 'pixel-art-icons/icons/square-solid'
import { ImageSolidIcon } from 'pixel-art-icons/icons/image-solid'
import { ContextMeter } from './ContextMeter'
import { ModelPicker } from './ModelPicker'
import {
  type AgentPreviewImage,
  type OpenAgentImageMenu,
} from './agentImageTypes'
import { PendingImageAttachmentGrid } from './PendingImageAttachmentGrid'
import { usePendingImageAttachments } from './usePendingImageAttachments'
import styles from './AgentPanel.module.css'

export type ComposerLockReason = 'setup' | 'chooseModel'

interface AgentComposerProps {
  composerLocked: boolean
  lockReason: ComposerLockReason | null
  credentials: CredentialView[]
  credentialsLoaded: boolean
  onRefreshCredentials(): void
  onOpenImage(image: AgentPreviewImage): void
  onOpenImageMenu: OpenAgentImageMenu
}

export function AgentComposer({
  composerLocked,
  lockReason,
  credentials,
  credentialsLoaded,
  onRefreshCredentials,
  onOpenImage,
  onOpenImageMenu,
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
  const attachments = usePendingImageAttachments()
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

  const hasAttachments = attachments.pending.length > 0
  const imageStatus = !hasAttachments
    ? 'none'
    : attachments.pending.some((entry) => entry.status === 'error')
      ? 'error'
      : attachments.pending.some((entry) => entry.status === 'processing')
        ? 'processing'
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
    const pending = attachments.current()
    if (!text && pending.length === 0) return
    if (pending.some((entry) => entry.status === 'processing')) {
      pushToast({ kind: 'error', title: 'Images are still processing', body: 'Wait a moment, then send again.' })
      return
    }
    if (pending.some((entry) => entry.status === 'error' || !entry.block)) return
    if (pending.length > 0 && imageStatus !== 'ready') return

    const content: AiUserContentBlock[] = []
    if (text) content.push({ kind: 'text', text })
    for (const entry of pending) {
      if (entry.block) content.push(entry.block)
    }

    setSubmitting(true)
    const result = await sendAgentMessage(content).finally(() => setSubmitting(false))
    if (result.accepted) {
      setDraft('')
      attachments.clear()
    }
  }

  function handlePaste(event: React.ClipboardEvent<HTMLTextAreaElement>): void {
    const imageFiles = Array.from(event.clipboardData.files).filter((file) =>
      file.type.startsWith('image/'),
    )
    if (imageFiles.length === 0) return
    event.preventDefault()
    attachments.queueFiles(imageFiles, AI_USER_IMAGE_MAX_PER_MESSAGE)
  }

  function handleImageSelection(event: ChangeEvent<HTMLInputElement>): void {
    const files = Array.from(event.currentTarget.files ?? [])
    // Let the same local file fire change again after it is removed.
    event.currentTarget.value = ''
    attachments.queueFiles(files, AI_USER_IMAGE_MAX_PER_MESSAGE)
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
      {hasAttachments && (
        <PendingImageAttachmentGrid
          entries={attachments.pending}
          actionsDisabled={submitting || isStreaming}
          onRemove={attachments.remove}
          onOpenImage={onOpenImage}
          onOpenImageMenu={onOpenImageMenu}
        />
      )}
      {hasAttachments && imageStatus === 'checking-model' && (
        <p role="status" className={styles.attachmentNotice}>Checking whether this model accepts images…</p>
      )}
      {hasAttachments && imageStatus === 'unsupported-model' && (
        <p role="alert" className={styles.attachmentWarning}>
          Choose a vision-capable model or remove the image.
        </p>
      )}
      {hasAttachments && imageStatus === 'model-error' && (
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
                : 'Tell me what to build… (attach images or press Enter to send)'}
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
          <div className={styles.inputControlActions}>
            <FileUpload
              multiple
              accept="image/png,image/jpeg,image/webp"
              onChange={handleImageSelection}
              buttonProps={{
                variant: 'ghost',
                size: 'sm',
                iconOnly: true,
                disabled: composerLocked
                  || isStreaming
                  || conversationPending
                  || providerPending
                  || submitting
                  || attachments.pending.length >= AI_USER_IMAGE_MAX_PER_MESSAGE,
                tooltip: attachments.pending.length >= AI_USER_IMAGE_MAX_PER_MESSAGE
                  ? `Maximum ${AI_USER_IMAGE_MAX_PER_MESSAGE} images per message`
                  : 'Attach images',
                'aria-label': 'Attach images',
              }}
            >
              <ImageSolidIcon size={14} aria-hidden="true" />
            </FileUpload>
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
        </div>
      </form>
    </div>
  )
}
