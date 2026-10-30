import { expect, test } from 'bun:test'
import { stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { PrivateArchiveFiles } from '../../../server/archive/privateFiles'
import { createStoredZipStream } from '../../../server/archive/storedZip'

test('private export snapshots have restricted permissions and are removed after download', async () => {
  const files = new PrivateArchiveFiles()
  const bytes = new TextEncoder().encode('Private contents')
  const path = await files.add(bytes)
  try {
    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o077).toBe(0)
      expect((await stat(dirname(path))).mode & 0o077).toBe(0)
    }
    const response = new Response(files.stream(createStoredZipStream([{ path: 'attachments/0', sizeBytes: bytes.length, source: path }])))
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(bytes.length)
    expect(await Bun.file(path).exists()).toBe(false)
  } finally {
    await files.cleanup()
  }
})

test('private export snapshots are removed after cancellation or a failed stream', async () => {
  const cancelled = new PrivateArchiveFiles()
  const path = await cancelled.add(new Uint8Array([1]))
  try {
    await cancelled.stream(createStoredZipStream([{ path: 'attachments/0', sizeBytes: 1, source: path }])).cancel()
    expect(await Bun.file(path).exists()).toBe(false)
  } finally {
    await cancelled.cleanup()
  }
  const failed = new PrivateArchiveFiles()
  const failedPath = await failed.add(new Uint8Array([1]))
  try {
    const stream = new ReadableStream<Uint8Array>({ pull() { throw new Error('Source failed') } })
    await expect(new Response(failed.stream(stream)).arrayBuffer()).rejects.toThrow('Source failed')
    expect(await Bun.file(failedPath).exists()).toBe(false)
  } finally {
    await failed.cleanup()
  }
})
