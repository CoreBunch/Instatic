/**
 * POST /admin/api/cms/media/lookup — which content hashes the media library
 * already holds. Site Import calls it to reuse files on a re-import instead of
 * uploading copies.
 */

import { describe, expect, it } from 'bun:test'
import { createMediaAsset, softDeleteMediaAsset } from '../../../server/repositories/media'
import { createCapabilityTestHarness, expectForbidden } from '../helpers/capabilityHarness'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

async function seedAsset(
  db: Parameters<typeof createMediaAsset>[0],
  id: string,
  contentHash?: string,
): Promise<void> {
  await createMediaAsset(db, {
    id,
    filename: `${id}.png`,
    mimeType: 'image/png',
    sizeBytes: 4,
    storagePath: `${id}.png`,
    publicPath: `/uploads/${id}.png`,
    uploadedByUserId: null,
    storageAdapterId: '',
    externallyHosted: false,
    ...(contentHash ? { contentHash } : {}),
  })
}

describe('media content-hash lookup', () => {
  it('returns live assets whose content hash matches, never trashed or unhashed ones', async () => {
    const harness = await createCapabilityTestHarness()
    try {
      const cookie = await harness.setupOwner()
      await seedAsset(harness.db, 'logo', HASH_A)
      await seedAsset(harness.db, 'trashed', HASH_B)
      await softDeleteMediaAsset(harness.db, 'trashed')
      await seedAsset(harness.db, 'legacy')

      const res = await harness.cms('/admin/api/cms/media/lookup', {
        method: 'POST',
        cookie,
        json: { contentHashes: [HASH_A, HASH_B, 'c'.repeat(64)] },
      })

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({
        matches: [{ contentHash: HASH_A, id: 'logo', publicPath: '/uploads/logo.png', filename: 'logo.png' }],
      })
    } finally {
      await harness.cleanup()
    }
  })

  it('rejects anything that is not a SHA-256 hex digest', async () => {
    const harness = await createCapabilityTestHarness()
    try {
      const cookie = await harness.setupOwner()
      const res = await harness.cms('/admin/api/cms/media/lookup', {
        method: 'POST',
        cookie,
        json: { contentHashes: ["' or 1=1 --"] },
      })
      expect(res.status).toBe(400)
    } finally {
      await harness.cleanup()
    }
  })

  it('takes one full import worth of hashes and refuses more', async () => {
    const harness = await createCapabilityTestHarness()
    try {
      const cookie = await harness.setupOwner()
      const hashes = (n: number) => Array.from({ length: n }, (_, i) => i.toString(16).padStart(64, '0'))
      const lookup = (contentHashes: string[]) =>
        harness.cms('/admin/api/cms/media/lookup', { method: 'POST', cookie, json: { contentHashes } })
      expect((await lookup(hashes(10_000))).status).toBe(200)
      expect((await lookup(hashes(10_001))).status).toBe(400)
    } finally {
      await harness.cleanup()
    }
  })

  it('needs media.read', async () => {
    const harness = await createCapabilityTestHarness()
    try {
      await harness.setupOwner()
      const writer = await harness.createRoleUser({ name: 'Writer', slug: 'writer', capabilities: ['media.write'] })
      await expectForbidden(await harness.cms('/admin/api/cms/media/lookup', {
        method: 'POST',
        cookie: writer.cookie,
        json: { contentHashes: [HASH_A] },
      }))
    } finally {
      await harness.cleanup()
    }
  })
})
