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

interface QueuedImage {
  entry: PendingImageAttachment
  file: File
}

/**
 * Ref-backed pending attachments with a sequential normalization queue.
 * Entries land in the ref before decoding starts, so a same-tick Enter cannot
 * send a partial paste. Sequential work also bounds browser decode memory when
 * several large source images are pasted together.
 */
export function usePendingImageAttachments() {
  const [pending, setPending] = useState<PendingImageAttachment[]>([])
  const pendingRef = useRef<PendingImageAttachment[]>([])
  const queueRef = useRef<QueuedImage[]>([])
  const operationsRef = useRef(new Map<string, AbortController>())
  const runningRef = useRef(false)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    const operations = operationsRef.current
    return () => {
      mountedRef.current = false
      queueRef.current = []
      for (const controller of operations.values()) controller.abort()
      operations.clear()
      pendingRef.current = []
    }
  }, [])

  function replacePending(next: PendingImageAttachment[]): void {
    pendingRef.current = next
    if (mountedRef.current) setPending(next)
  }

  function updatePending(
    id: string,
    update: (entry: PendingImageAttachment) => PendingImageAttachment,
  ): void {
    const index = pendingRef.current.findIndex((entry) => entry.id === id)
    if (index === -1) return
    const next = [...pendingRef.current]
    next[index] = update(next[index]!)
    replacePending(next)
  }

  function processQueue(): void {
    if (runningRef.current) return
    runningRef.current = true

    void (async () => {
      try {
        while (mountedRef.current) {
          const queued = queueRef.current.shift()
          if (!queued) break
          if (!pendingRef.current.some((entry) => entry.id === queued.entry.id)) continue

          const controller = new AbortController()
          operationsRef.current.set(queued.entry.id, controller)
          try {
            const block = await normaliseAgentImage(queued.file, controller.signal)
            if (controller.signal.aborted) continue
            updatePending(queued.entry.id, (entry) => ({
              ...entry,
              previewUrl: `data:${block.mimeType};base64,${block.data}`,
              status: 'ready',
              block,
            }))
          } catch (err) {
            if (controller.signal.aborted || isAbortError(err)) continue
            const message = getErrorMessage(err, 'The pasted image could not be prepared.')
            updatePending(queued.entry.id, (entry) => ({
              ...entry,
              status: 'error',
              error: message,
            }))
            pushToast({ kind: 'error', title: "Couldn't attach image", body: message })
          } finally {
            operationsRef.current.delete(queued.entry.id)
          }
        }
      } finally {
        runningRef.current = false
        if (mountedRef.current && queueRef.current.length > 0) processQueue()
      }
    })()
  }

  function queueFiles(files: File[], maxAttachments: number): void {
    const accepted: File[] = []
    for (const file of files) {
      if (!isAiUserImageSourceMimeType(file.type)) {
        pushToast({
          kind: 'error',
          title: 'Unsupported image',
          body: 'Use a PNG, JPEG, or WebP image.',
        })
        continue
      }
      if (file.size > AI_USER_IMAGE_MAX_SOURCE_BYTES) {
        pushToast({
          kind: 'error',
          title: 'Image too large',
          body: `Source images must be smaller than ${(AI_USER_IMAGE_MAX_SOURCE_BYTES / 1_000_000).toFixed(1)} MB.`,
        })
        continue
      }
      accepted.push(file)
    }

    const remaining = Math.max(0, maxAttachments - pendingRef.current.length)
    const filesToQueue = accepted.slice(0, remaining)
    const overflow = accepted.length - filesToQueue.length
    if (overflow > 0) {
      pushToast({
        kind: 'error',
        title: 'Message image limit reached',
        body: `A message can contain up to ${maxAttachments} images. ${overflow} ${overflow === 1 ? 'image was' : 'images were'} not attached.`,
      })
    }
    if (filesToQueue.length === 0) return

    const queued = filesToQueue.map((file): QueuedImage => ({
      file,
      entry: {
        id: nanoid(),
        filename: file.name || 'Pasted image',
        // Never preview the unbounded source. The URL appears only after the
        // image has passed normalization and size limits.
        previewUrl: null,
        status: 'processing',
      },
    }))
    replacePending([...pendingRef.current, ...queued.map(({ entry }) => entry)])
    queueRef.current.push(...queued)
    processQueue()
  }

  function remove(id: string): void {
    operationsRef.current.get(id)?.abort()
    operationsRef.current.delete(id)
    queueRef.current = queueRef.current.filter(({ entry }) => entry.id !== id)
    replacePending(pendingRef.current.filter((entry) => entry.id !== id))
  }

  function clear(): void {
    queueRef.current = []
    for (const controller of operationsRef.current.values()) controller.abort()
    operationsRef.current.clear()
    replacePending([])
  }

  return {
    pending,
    current: () => pendingRef.current,
    queueFiles,
    remove,
    clear,
  }
}
