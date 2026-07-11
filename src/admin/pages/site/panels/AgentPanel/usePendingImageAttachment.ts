import { useEffect, useRef, useState } from 'react'
import { nanoid } from 'nanoid'
import {
  AI_USER_IMAGE_MAX_SOURCE_BYTES,
  isAiUserImageSourceMimeType,
  type AiUserImageBlock,
} from '@core/ai'
import { getErrorMessage } from '@core/utils/errorMessage'
import { isAbortError } from '@core/http'
import { pushToast } from '@ui/components/Toast'
import { normaliseAgentImage } from './agentImageAttachment'

export interface PendingImageAttachment {
  id: string
  filename: string
  previewUrl: string | null
  status: 'processing' | 'ready' | 'error'
  block?: AiUserImageBlock
  error?: string
}

/**
 * One ref-backed pending attachment. The ref is updated inside the paste event
 * before async normalisation starts, so a same-tick Enter press cannot observe
 * an empty queue and send the image with a later turn.
 */
export function usePendingImageAttachment() {
  const [pending, setPending] = useState<PendingImageAttachment | null>(null)
  const pendingRef = useRef<PendingImageAttachment | null>(null)
  const operationRef = useRef<AbortController | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    // React Strict Mode runs the development setup/cleanup cycle twice.
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      operationRef.current?.abort()
      operationRef.current = null
      pendingRef.current = null
    }
  }, [])

  function queueFile(file: File): void {
    if (pendingRef.current) {
      pushToast({
        kind: 'error',
        title: 'One image per message',
        body: 'Remove the current image before pasting another.',
      })
      return
    }
    if (!isAiUserImageSourceMimeType(file.type)) {
      pushToast({
        kind: 'error',
        title: 'Unsupported image',
        body: 'Use a PNG, JPEG, or WebP image.',
      })
      return
    }
    if (file.size > AI_USER_IMAGE_MAX_SOURCE_BYTES) {
      pushToast({
        kind: 'error',
        title: 'Image too large',
        body: `Source images must be smaller than ${(AI_USER_IMAGE_MAX_SOURCE_BYTES / 1_000_000).toFixed(1)} MB.`,
      })
      return
    }

    const entry: PendingImageAttachment = {
      id: nanoid(),
      filename: file.name || 'Pasted image',
      // Do not point <img> at the unbounded source; the ready state swaps in
      // the already-normalised 1.5 MP JPEG data URL.
      previewUrl: null,
      status: 'processing',
    }
    pendingRef.current = entry
    setPending(entry)

    const controller = new AbortController()
    operationRef.current = controller
    void normaliseAgentImage(file, controller.signal).then(
      (block) => {
        if (operationRef.current === controller) operationRef.current = null
        if (!mountedRef.current || pendingRef.current?.id !== entry.id) return
        const ready: PendingImageAttachment = {
          ...entry,
          previewUrl: `data:${block.mimeType};base64,${block.data}`,
          status: 'ready',
          block,
        }
        pendingRef.current = ready
        setPending(ready)
      },
      (err) => {
        if (operationRef.current === controller) operationRef.current = null
        if (controller.signal.aborted || isAbortError(err)) return
        if (!mountedRef.current || pendingRef.current?.id !== entry.id) return
        const message = getErrorMessage(err, 'The pasted image could not be prepared.')
        const failed: PendingImageAttachment = { ...entry, status: 'error', error: message }
        pendingRef.current = failed
        setPending(failed)
        pushToast({ kind: 'error', title: "Couldn't attach image", body: message })
      },
    )
  }

  function remove(): void {
    operationRef.current?.abort()
    operationRef.current = null
    pendingRef.current = null
    setPending(null)
  }

  return {
    pending,
    current: () => pendingRef.current,
    queueFile,
    remove,
    clear: remove,
  }
}
