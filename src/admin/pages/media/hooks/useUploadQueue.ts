/**
 * useUploadQueue — keeps a queue of in-flight + finished uploads so the
 * floating Upload Queue window can show per-file progress, retries, and
 * "Open in folder" links.
 *
 * Why not the existing `uploadCmsMediaAssets` helper from `cmsMedia.ts`?
 * Because `fetch()` does not expose upload progress events — for that we
 * need `XMLHttpRequest`. The XHR pipeline lives entirely in this hook;
 * everything else still goes through `cmsMedia.ts`.
 *
 * The queue lives at the workspace level (mounted once per Media page) so
 * uploads survive folder navigation: a user can open a folder, drop ten
 * files, navigate to a different folder, and watch the queue continue to
 * drain in the corner.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { checkSizeLimit } from '@core/files/upload'
import { compiledCheck } from '@core/utils/typeboxCompiler'
import {
  setCmsMediaAssetFolders,
  type CmsMediaAsset,
} from '@core/persistence/cmsMedia'
import {
  CmsMediaAssetEnvelopeSchema,
  type CmsMediaAssetWire,
} from '@core/persistence/responseSchemas'
import { getErrorMessage } from '@core/utils/errorMessage'

type UploadStatus = 'queued' | 'uploading' | 'succeeded' | 'failed' | 'cancelled'

export interface UploadItem {
  id: string
  file: File
  /** 0–1, only meaningful when status === 'uploading'. */
  progress: number
  status: UploadStatus
  error: string | null
  /** Persisted asset on success — passed back so the queue can link to it. */
  asset: CmsMediaAsset | null
  /** Target folder id at enqueue time, or null for unfiled. */
  folderId: string | null
  /** Wall-clock when the queue first saw this file (for sort order). */
  startedAt: number
}

interface NormalizeAsset {
  (wire: CmsMediaAssetWire): CmsMediaAsset
}

interface UseUploadQueueOptions {
  normalize: NormalizeAsset
  /** Called after a successful upload so the workspace can splice the asset into its list. */
  onUploaded: (asset: CmsMediaAsset) => void
  /** Max parallel uploads. Defaults to 3. */
  concurrency?: number
}

export interface UseUploadQueueResult {
  items: UploadItem[]
  /** `true` when at least one upload is queued or in-flight. */
  active: boolean
  enqueue: (files: File[], folderId: string | null) => void
  retry: (uploadId: string) => void
  remove: (uploadId: string) => void
  /** Drop every finished entry (succeeded / failed / cancelled). Keeps in-flight rows. */
  clearFinished: () => void
  /** Abort any in-flight upload. Queued items move to `cancelled`. */
  cancelAll: () => void
}

interface ActiveTransfer {
  xhr: XMLHttpRequest
}

let nextItemId = 0
function makeId() {
  nextItemId += 1
  return `u_${Date.now().toString(36)}_${nextItemId}`
}

export function useUploadQueue({
  normalize,
  onUploaded,
  concurrency = 3,
}: UseUploadQueueOptions): UseUploadQueueResult {
  const [items, setItems] = useState<UploadItem[]>([])
  const itemsRef = useRef<UploadItem[]>([])
  const transfersRef = useRef<Map<string, ActiveTransfer>>(new Map())
  // Track in-flight count separately from items array so the pump can decide
  // whether to start another upload without scanning the full list.
  const inFlightRef = useRef(0)

  // Exception #1: feeds the transitive closure of `pump`, which is a useEffect dependency.
  const setItemsAndMirror = useCallback((updater: (prev: UploadItem[]) => UploadItem[]) => {
    // CRITICAL: the ref is the queue's source of truth — pump() reads it
    // synchronously and within the same tick as enqueue() / patchItem()
    // schedule state updates. React's functional setState updater runs
    // lazily (next render), so if we mirrored INSIDE the setItems updater
    // the ref would lag a tick behind reality. Compute next from the
    // current ref, write the ref first, THEN push to React state with a
    // plain value (not a functional updater) so re-renders stay in sync.
    const next = updater(itemsRef.current)
    itemsRef.current = next
    setItems(next)
  }, [])

  // Exception #1: feeds the transitive closure of `pump`, which is a useEffect dependency.
  const patchItem = useCallback((id: string, patch: Partial<UploadItem>) => {
    setItemsAndMirror((prev) => prev.map((item) => item.id === id ? { ...item, ...patch } : item))
  }, [setItemsAndMirror])

  // `runUpload` and `pump` are mutually recursive: every transfer end calls
  // pump() to start the next queued item. To keep both useCallbacks stable
  // and avoid TDZ-style "use before declared" lints, we route the back-edge
  // through a ref. Either order of declaration is fine then.
  const pumpRef = useRef<() => void>(() => {})

  // ── Single-upload pipeline ────────────────────────────────────────────────
  // Exception #1: feeds the transitive closure of `pump`, which is a useEffect dependency.
  const runUpload = useCallback((item: UploadItem) => {
    inFlightRef.current += 1
    patchItem(item.id, { status: 'uploading', progress: 0, error: null })

    const xhr = new XMLHttpRequest()
    transfersRef.current.set(item.id, { xhr })

    xhr.open('POST', '/admin/api/cms/media', true)
    xhr.withCredentials = true
    xhr.responseType = 'json'

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        patchItem(item.id, { progress: event.loaded / event.total })
      }
    }

    xhr.onload = async () => {
      transfersRef.current.delete(item.id)
      inFlightRef.current = Math.max(0, inFlightRef.current - 1)

      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          // Validate the envelope shape at the boundary just like the fetch
          // path does (`parseJsonResponse`) — XHR returns the parsed JSON
          // via responseType: 'json'.
          const data = xhr.response as unknown
          if (!compiledCheck(CmsMediaAssetEnvelopeSchema, data)) {
            patchItem(item.id, {
              status: 'failed',
              error: 'Server response did not match the expected shape',
              progress: 1,
            })
            pumpRef.current()
            return
          }
          const wire = (data as { asset: CmsMediaAssetWire }).asset
          let asset = normalize(wire)
          if (item.folderId) {
            try {
              asset = await setCmsMediaAssetFolders(asset.id, { add: [item.folderId] })
            } catch (folderErr) {
              // Folder assignment is best-effort — the upload itself
              // succeeded. Surface the issue on the queue row so the user
              // can retry with the asset already in place.
              patchItem(item.id, {
                status: 'succeeded',
                asset,
                error: getErrorMessage(folderErr, 'Folder assignment failed'),
                progress: 1,
              })
              onUploaded(asset)
              pumpRef.current()
              return
            }
          }
          patchItem(item.id, { status: 'succeeded', asset, error: null, progress: 1 })
          onUploaded(asset)
        } catch (err) {
          patchItem(item.id, {
            status: 'failed',
            error: getErrorMessage(err, 'Upload failed'),
          })
        }
      } else {
        const message = extractXhrErrorMessage(xhr) ?? `Upload failed with ${xhr.status}`
        patchItem(item.id, { status: 'failed', error: message })
      }
      pumpRef.current()
    }

    xhr.onerror = () => {
      transfersRef.current.delete(item.id)
      inFlightRef.current = Math.max(0, inFlightRef.current - 1)
      patchItem(item.id, { status: 'failed', error: 'Network error during upload' })
      pumpRef.current()
    }

    xhr.onabort = () => {
      transfersRef.current.delete(item.id)
      inFlightRef.current = Math.max(0, inFlightRef.current - 1)
      patchItem(item.id, { status: 'cancelled', error: null })
      pumpRef.current()
    }

    const body = new FormData()
    body.set('file', item.file)
    xhr.send(body)
  }, [normalize, onUploaded, patchItem])

  // ── Pump: start additional uploads up to the concurrency cap ──────────────
  // Relies on `setItemsAndMirror` writing the ref synchronously so the
  // next iteration of the while loop sees `runUpload`'s status change
  // immediately. Without that ref-sync, this loop would re-pick the same
  // 'queued' item for every spare slot and trigger duplicate uploads.
  // Exception #1: referenced in the useEffect dependency array below.
  const pump = useCallback(() => {
    while (inFlightRef.current < concurrency) {
      const next = itemsRef.current.find((item) => item.status === 'queued')
      if (!next) return
      runUpload(next)
    }
  }, [concurrency, runUpload])

  // Mirror `pump` into the ref so the XHR callbacks (which closed over the
  // initial empty pump) always invoke the latest version.
  useEffect(() => { pumpRef.current = pump }, [pump])

  const enqueue = (files: File[], folderId: string | null) => {
    const additions: UploadItem[] = []
    for (const file of files) {
      const sizeCheck = checkSizeLimit(file.size)
      const id = makeId()
      additions.push({
        id,
        file,
        progress: 0,
        status: sizeCheck.ok ? 'queued' : 'failed',
        error: sizeCheck.ok ? null : sizeCheck.message ?? `${file.name} exceeds the upload size limit`,
        asset: null,
        folderId,
        startedAt: Date.now(),
      })
    }
    if (additions.length === 0) return
    setItemsAndMirror((prev) => [...additions, ...prev])
    pump()
  }

  const retry = (uploadId: string) => {
    const item = itemsRef.current.find((entry) => entry.id === uploadId)
    if (!item || (item.status !== 'failed' && item.status !== 'cancelled')) return
    patchItem(uploadId, { status: 'queued', error: null, progress: 0 })
    pump()
  }

  const remove = (uploadId: string) => {
    const transfer = transfersRef.current.get(uploadId)
    if (transfer) transfer.xhr.abort()
    setItemsAndMirror((prev) => prev.filter((item) => item.id !== uploadId))
  }

  const clearFinished = () => {
    setItemsAndMirror((prev) => prev.filter((item) =>
      item.status === 'queued' || item.status === 'uploading',
    ))
  }

  const cancelAll = () => {
    for (const [, transfer] of transfersRef.current) transfer.xhr.abort()
    setItemsAndMirror((prev) => prev.map((item) =>
      item.status === 'queued' ? { ...item, status: 'cancelled' as const } : item,
    ))
  }

  const active = items.some((item) => item.status === 'queued' || item.status === 'uploading')

  return { items, active, enqueue, retry, remove, clearFinished, cancelAll }
}

function extractXhrErrorMessage(xhr: XMLHttpRequest): string | null {
  const response = xhr.response as unknown
  if (response && typeof response === 'object' && 'error' in response) {
    const errorField = (response as { error?: unknown }).error
    if (typeof errorField === 'string') return errorField
  }
  return null
}
