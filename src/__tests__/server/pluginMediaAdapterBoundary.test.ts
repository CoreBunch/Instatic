import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { buildAdapterShim } from '../../../server/plugins/host/media'
import { pendingRequests, workers } from '../../../server/plugins/host/workerState'
import type { MainToWorkerMessage } from '../../../server/plugins/protocol/messages'

let workerValue: unknown

function stubWorker(): Worker {
  return {
    postMessage(message: MainToWorkerMessage) {
      if (message.kind !== 'run-media-adapter-call') {
        throw new Error(`Unexpected worker message kind: ${message.kind}`)
      }
      const pending = pendingRequests.get(message.correlationId)
      if (!pending) {
        throw new Error(`Missing pending worker request: ${message.correlationId}`)
      }
      pendingRequests.delete(message.correlationId)
      pending.resolve({
        kind: 'media-adapter-call-result',
        correlationId: message.correlationId,
        ok: true,
        value: workerValue,
      })
    },
    terminate() { /* no-op test worker */ },
    addEventListener() { /* no-op test worker */ },
  } as unknown as Worker
}

function adapter() {
  return buildAdapterShim({
    pluginId: 'acme.media',
    adapterId: 'acme.media.store',
    label: 'Acme media',
    roles: ['original'],
    servingMode: 'public-url',
    hasGetReadUrl: true,
    hasReadStream: false,
  })
}

describe('plugin media adapter host boundary', () => {
  beforeEach(() => {
    workerValue = undefined
    workers.set('acme.media', stubWorker())
  })

  afterEach(() => {
    workers.clear()
    pendingRequests.clear()
  })

  it('rejects plugin upload plans that try to use the host-only LOCAL transport', async () => {
    workerValue = {
      storagePath: 'uploads/pwn.png',
      steps: [{
        method: 'LOCAL',
        url: 'file:///tmp/pwn.png',
        headers: {},
      }],
      expiresAt: Date.now() + 60_000,
    }

    await expect(adapter().beginWrite({
      mimeType: 'image/png',
      suggestedStoragePath: 'uploads/pwn.png',
      contentHash: '0'.repeat(64),
      sizeBytes: 1,
      role: 'original',
    })).rejects.toThrow(/malformed upload plan/i)
  })

  it('rejects malformed plugin upload plans instead of casting worker output', async () => {
    workerValue = {
      storagePath: 'uploads/pwn.png',
      steps: [{
        method: 'PUT',
        url: 'https://storage.example/upload',
        headers: [],
      }],
      expiresAt: Date.now() + 60_000,
    }

    await expect(adapter().beginWrite({
      mimeType: 'image/png',
      suggestedStoragePath: 'uploads/pwn.png',
      contentHash: '0'.repeat(64),
      sizeBytes: 1,
      role: 'original',
    })).rejects.toThrow(/malformed upload plan/i)
  })
})
