/**
 * Host-side facade for the image-variant worker pool.
 *
 * Submits a job to the next available worker (or queues it when all are
 * busy), waits for the worker's reply, and returns it. Workers are lazily
 * spawned on first use and reused for the life of the process — `bun
 * test` and `bun --watch` both reuse the same pool across requests.
 *
 * Concurrency:
 *   - Pool size defaults to `2` (one big upload doesn't starve a
 *     concurrent one) and is bounded by `IMAGE_VARIANT_WORKER_POOL_SIZE`.
 *   - Each worker handles one job at a time (sharp itself is happy to
 *     spin up libvips threads inside a worker; we don't want to fight
 *     it on concurrency).
 *   - Jobs over the pool size are FIFO-queued. No prioritisation — uploads
 *     are user-driven and naturally serialise per admin click.
 *
 * Crash handling:
 *   - A worker error rejects the currently-assigned job's promise and
 *     drops the dead worker from the pool. The next submission spawns a
 *     replacement. We do not auto-respawn eagerly — there's no work
 *     until a caller asks for some.
 *
 * Why a fresh module-level pool (not the plugin worker pool):
 *   - Different trust boundary. Plugin workers run untrusted code in
 *     QuickJS and need crash budgeting, settings mirroring, capability
 *     gating. The image-variant worker runs trusted, host-authored
 *     code; it can `import sharp` directly, no sandbox required.
 *   - Different lifecycle. Plugin workers are per-plugin-id and live
 *     across activate / deactivate cycles. The image-variant pool is
 *     a flat, fixed-size set.
 */

import type {
  ImageVariantJobRequest,
  ImageVariantJobResponse,
  ImageVariantJobOk,
} from './imageVariantProtocol'

interface WorkerSlot {
  worker: Worker
  /** Correlation id of the job currently owned by this worker, or `null` when idle. */
  currentCorrelationId: string | null
}

interface PendingJob {
  resolve: (response: ImageVariantJobResponse) => void
  reject: (err: Error) => void
}

interface QueuedJob {
  req: ImageVariantJobRequest
  transfer: ArrayBuffer[]
}

const DEFAULT_POOL_SIZE = 2

function readPoolSize(): number {
  const raw = process.env.IMAGE_VARIANT_WORKER_POOL_SIZE
  if (!raw) return DEFAULT_POOL_SIZE
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_POOL_SIZE
  // Bound the pool size — a misconfigured huge value would let a burst of
  // uploads spawn enough workers to OOM the host. 8 is comfortably above
  // any plausible self-hosted ceiling.
  return Math.min(8, Math.floor(parsed))
}

const POOL_SIZE = readPoolSize()
const slots: WorkerSlot[] = []
const pending = new Map<string, PendingJob>()
const queue: QueuedJob[] = []
let correlationCounter = 0

function nextCorrelationId(): string {
  correlationCounter += 1
  return `iv-${correlationCounter.toString(36)}-${Date.now().toString(36)}`
}

function spawnSlot(): WorkerSlot {
  const worker = new Worker(new URL('./imageVariantWorker.ts', import.meta.url).href)
  const slot: WorkerSlot = { worker, currentCorrelationId: null }
  worker.addEventListener('message', (event: MessageEvent) => {
    handleWorkerMessage(slot, event.data)
  })
  worker.addEventListener('error', (event: ErrorEvent) => {
    console.error('[imageVariantWorker] uncaught error:', event.message, event.error)
    handleWorkerError(slot, event.message)
  })
  return slot
}

function ensurePool(): void {
  while (slots.length < POOL_SIZE) {
    slots.push(spawnSlot())
  }
}

function handleWorkerMessage(slot: WorkerSlot, raw: unknown): void {
  if (!raw || typeof raw !== 'object') return
  const msg = raw as Partial<ImageVariantJobResponse>
  if (msg.kind !== 'image-variant-result' || typeof msg.correlationId !== 'string') return
  const job = pending.get(msg.correlationId)
  pending.delete(msg.correlationId)
  if (slot.currentCorrelationId === msg.correlationId) {
    slot.currentCorrelationId = null
  }
  if (job) job.resolve(msg as ImageVariantJobResponse)
  drainQueue()
}

function handleWorkerError(slot: WorkerSlot, message: string): void {
  // Reject the job the dead worker was holding, if any.
  if (slot.currentCorrelationId) {
    const job = pending.get(slot.currentCorrelationId)
    pending.delete(slot.currentCorrelationId)
    if (job) job.reject(new Error(`image-variant worker crashed: ${message}`))
  }
  // Drop the dead slot from the pool. A subsequent submission will spawn
  // a replacement via `ensurePool`. We don't eagerly respawn — there may
  // be no upload traffic for a while and we don't want to keep restarting
  // a worker that's failing for an environmental reason.
  const idx = slots.indexOf(slot)
  if (idx >= 0) slots.splice(idx, 1)
  try {
    slot.worker.terminate()
  } catch {
    /* worker already dead */
  }
  drainQueue()
}

function drainQueue(): void {
  for (const slot of slots) {
    if (slot.currentCorrelationId !== null) continue
    const next = queue.shift()
    if (!next) return
    slot.currentCorrelationId = next.req.correlationId
    slot.worker.postMessage(next.req, next.transfer)
  }
}

type ImageVariantJobInput = Omit<ImageVariantJobRequest, 'kind' | 'correlationId'>

/**
 * Submit one image-variant job and await its result. The input `bytes`
 * are transferred (the caller's view becomes detached after this call
 * returns its promise). Encoded variant bytes come back as transferable
 * ArrayBuffers — copy them into Uint8Array views to consume.
 */
export function runImageVariantJob(input: ImageVariantJobInput): Promise<ImageVariantJobResponse> {
  ensurePool()
  const correlationId = nextCorrelationId()
  const req: ImageVariantJobRequest = {
    kind: 'image-variant-job',
    correlationId,
    ...input,
  }
  return new Promise<ImageVariantJobResponse>((resolve, reject) => {
    pending.set(correlationId, { resolve, reject })
    queue.push({ req, transfer: [req.bytes] })
    drainQueue()
  })
}

/** Narrow helper for the success branch — saves callers a discriminant check. */
export function isImageVariantOk(
  response: ImageVariantJobResponse,
): response is ImageVariantJobOk {
  return response.ok === true
}

