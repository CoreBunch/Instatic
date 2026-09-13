import { describe, expect, it } from 'bun:test'
import { executeUploadPlan } from '../../../server/handlers/cms/mediaUploadExecutor'

/**
 * GHSA-9pq7: the write-side sibling of GHSA-rmm7.
 *
 * A storage-adapter plugin holds `media.storage.adapter`, not
 * `network.outbound`. Its `beginWrite` returns an upload plan whose step URLs
 * the host then fetches itself. That plan is validated for SHAPE only, so a
 * malicious adapter could name any URL — loopback, link-local metadata, a
 * private LAN service — and the host would issue a PUT/POST at it carrying
 * plugin-chosen headers and the media bytes. GHSA-rmm7 closed this on the read
 * path; the write path kept a raw `fetch()` until now.
 *
 * The plan URL now goes through the same SSRF guard: internal addresses are
 * refused before a connection is opened, the connection is pinned to the
 * checked IP, and every redirect hop is re-validated.
 */
describe('media upload plan execution (GHSA-9pq7)', () => {
  const bytes = new Uint8Array([1, 2, 3, 4])

  function plan(url: string, method: 'PUT' | 'POST' = 'PUT') {
    return {
      storagePath: 'asset.png',
      expiresAt: Date.now() + 60_000,
      steps: [{ method, url, headers: { 'x-canary': '1' } }],
    }
  }

  it('refuses an upload step aimed at cloud metadata', async () => {
    await expect(
      executeUploadPlan(plan('http://169.254.169.254/latest/meta-data/'), bytes),
    ).rejects.toThrow(/blocked address/i)
  })

  it('refuses an upload step aimed at loopback', async () => {
    await expect(
      executeUploadPlan(plan('http://127.0.0.1:8080/probe'), bytes),
    ).rejects.toThrow(/blocked address/i)
  })

  it('refuses a POST step aimed at a private LAN address', async () => {
    await expect(
      executeUploadPlan(plan('http://192.168.1.1/admin', 'POST'), bytes),
    ).rejects.toThrow(/blocked address/i)
  })

  it('refuses a non-canonical IPv6 loopback spelling', async () => {
    await expect(
      executeUploadPlan(plan('http://[0:0:0:0:0:0:0:1]:8080/probe'), bytes),
    ).rejects.toThrow(/blocked address/i)
  })

  it('refuses a non-HTTP scheme', async () => {
    await expect(
      executeUploadPlan(plan('file:///etc/passwd'), bytes),
    ).rejects.toThrow()
  })
})
