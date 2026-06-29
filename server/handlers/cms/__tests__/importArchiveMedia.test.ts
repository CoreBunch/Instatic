/**
 * Security regression tests: ISS-import-media-validation
 *
 * The site-bundle archive import path writes media bytes to disk without
 * magic-byte re-validation or SVG sanitization. An actor with `data.import`
 * capability could smuggle:
 *
 *   (a) An SVG carrying a <script> payload — served by the static handler
 *       and executed in the publisher's origin.
 *   (b) A MIME-mismatched file (manifest says image/jpeg, bytes are
 *       SVG/HTML/executable) — bypasses the upload pipeline's type gate.
 *
 * These tests prove both paths are closed after the fix.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createTestDb, type TestDb } from '../../../../src/__tests__/helpers/createTestDb'
import { importStagedArchiveMediaEntries } from '../importArchive'

const enc = new TextEncoder()

/** Minimal media-asset manifest entry fixture. */
function makeAsset(overrides: {
  id?: string
  mimeType: string
  storagePath: string
  sizeBytes: number
}) {
  return {
    id: overrides.id ?? 'test-asset-1',
    filename: 'test-file',
    mimeType: overrides.mimeType,
    sizeBytes: overrides.sizeBytes,
    storagePath: overrides.storagePath,
    altText: '',
    caption: '',
    title: '',
    tags: [] as string[],
    width: null,
    height: null,
    durationMs: null,
    dominantColor: null,
    blurHash: null,
    posterPath: null,
    folderIds: [] as string[],
  }
}

describe('importStagedArchiveMediaEntries — media byte security validation', () => {
  let testDb: TestDb
  let stagingDir: string
  let uploadsDir: string

  beforeEach(async () => {
    testDb = await createTestDb()
    stagingDir = await mkdtemp(join(tmpdir(), 'instatic-test-staging-'))
    uploadsDir = await mkdtemp(join(tmpdir(), 'instatic-test-uploads-'))
  })

  afterEach(async () => {
    await testDb.cleanup()
    await rm(stagingDir, { recursive: true, force: true })
    await rm(uploadsDir, { recursive: true, force: true })
  })

  /**
   * (a) SVG with <script> payload must be sanitized before disk write.
   *
   * An attacker crafts a bundle where a media entry has mimeType image/svg+xml
   * and the bytes contain a <script>alert(1)</script> payload. After import,
   * the file on disk must not contain the script — it must have been sanitized
   * by the same sanitizeSvgBytes pass the upload pipeline uses.
   */
  it('SVG with <script> payload ends up sanitized on disk after staged import', async () => {
    const svgWithScript = '<svg viewBox="0 0 10 10"><script>alert(1)</script><rect width="10" height="10"/></svg>'
    const svgBytes = enc.encode(svgWithScript)
    const stagedPath = join(stagingDir, '0.bin')
    await writeFile(stagedPath, svgBytes)

    const asset = makeAsset({
      mimeType: 'image/svg+xml',
      storagePath: 'test-icon.svg',
      sizeBytes: svgBytes.length,
    })

    await importStagedArchiveMediaEntries({
      stagedMedia: { stagingDir, entries: [{ asset, stagedPath }] },
      db: testDb.db,
      uploadsDir,
      importedFolderIds: new Set(),
    })

    const finalPath = join(uploadsDir, asset.storagePath)
    const content = await Bun.file(finalPath).text()
    // Script must be stripped
    expect(content.toLowerCase()).not.toContain('<script')
    expect(content.toLowerCase()).not.toContain('alert(1)')
    // Benign geometry must be preserved
    expect(content).toContain('<rect')
  })

  /**
   * (b) MIME mismatch — manifest says image/jpeg but bytes are an SVG.
   *
   * An attacker declares mimeType: "image/jpeg" in the manifest but provides
   * SVG bytes (which would be detected by magic-byte sniffing as image/svg+xml).
   * The import must reject this entry with a clear error rather than trusting
   * the manifest's declared type.
   */
  it('rejects an entry whose manifest mimeType does not match the detected MIME from bytes (SVG bytes declared as image/jpeg)', async () => {
    const svgContent = '<svg><rect width="10" height="10"/></svg>'
    const svgBytes = enc.encode(svgContent)
    const stagedPath = join(stagingDir, '0.bin')
    await writeFile(stagedPath, svgBytes)

    // Manifest lies: says JPEG but bytes are SVG
    const asset = makeAsset({
      mimeType: 'image/jpeg',
      storagePath: 'fake-photo.jpg',
      sizeBytes: svgBytes.length,
    })

    await expect(
      importStagedArchiveMediaEntries({
        stagedMedia: { stagingDir, entries: [{ asset, stagedPath }] },
        db: testDb.db,
        uploadsDir,
        importedFolderIds: new Set(),
      }),
    ).rejects.toThrow()
  })

  /**
   * Extension laundering: manifest mimeType is image/svg+xml (bytes match)
   * but storagePath has a .html extension. Static handler would serve it as
   * text/html. The import must reject the extension mismatch.
   */
  it('rejects an SVG entry whose storagePath extension does not match the detected MIME', async () => {
    const svgContent = '<svg><rect width="10" height="10"/></svg>'
    const svgBytes = enc.encode(svgContent)
    const stagedPath = join(stagingDir, '0.bin')
    await writeFile(stagedPath, svgBytes)

    // Correct MIME but wrong extension (could be served as text/html by static handler)
    const asset = makeAsset({
      mimeType: 'image/svg+xml',
      storagePath: 'exploit.html',
      sizeBytes: svgBytes.length,
    })

    await expect(
      importStagedArchiveMediaEntries({
        stagedMedia: { stagingDir, entries: [{ asset, stagedPath }] },
        db: testDb.db,
        uploadsDir,
        importedFolderIds: new Set(),
      }),
    ).rejects.toThrow()
  })
})
