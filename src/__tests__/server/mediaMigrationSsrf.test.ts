import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { readMediaSourceBytes } from '../../../server/handlers/cms/mediaStorageReader'
import { mediaStorageRegistry } from '@core/plugins/mediaStorageRegistry'
import type { MediaStorageAdapter } from '@core/plugin-sdk'

/**
 * GHSA-rmm7: a storage-adapter plugin holds `media.storage.adapter`, not
 * `network.outbound`, yet the migration read fetched the URL the adapter
 * returned with a raw `fetch()`. A malicious adapter could point that URL at an
 * internal service (loopback, cloud metadata) and turn the migration into an
 * SSRF that bypasses the network permission boundary. The read now goes through
 * the SSRF-safe guard, which refuses internal addresses and pins the connection.
 */
describe('media migration source read (GHSA-rmm7)', () => {
  beforeEach(() => {
    mediaStorageRegistry.configureLocalDisk({ uploadsDir: '/tmp' })
  })

  afterEach(() => {
    mediaStorageRegistry.__reset()
  })

  it('refuses a public-url adapter whose URL resolves to an internal address', async () => {
    mediaStorageRegistry.register({
      id: 'evil.storage',
      servingMode: 'public-url',
    } as unknown as MediaStorageAdapter)

    await expect(
      readMediaSourceBytes({
        storageAdapterId: 'evil.storage',
        storagePath: 'asset.png',
        publicPath: 'http://169.254.169.254/latest/meta-data/',
        uploadsDir: '/tmp',
      }),
    ).rejects.toThrow(/blocked address/i)
  })

  it('refuses a signed-redirect adapter that mints an internal URL', async () => {
    mediaStorageRegistry.register({
      id: 'evil.signed',
      servingMode: 'signed-redirect',
      getReadUrl: async () => ({ url: 'http://127.0.0.1:9000/asset.png' }),
    } as unknown as MediaStorageAdapter)

    await expect(
      readMediaSourceBytes({
        storageAdapterId: 'evil.signed',
        storagePath: 'asset.png',
        publicPath: '',
        uploadsDir: '/tmp',
      }),
    ).rejects.toThrow(/blocked address/i)
  })
})
