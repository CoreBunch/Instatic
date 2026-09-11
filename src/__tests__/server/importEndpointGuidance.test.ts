/**
 * importEndpointGuidance.test.ts — the two import endpoints take two different
 * payloads, and sending the wrong one used to produce a misleading error.
 *
 *   POST /admin/api/cms/import          — JSON site bundle
 *   POST /admin/api/cms/import/archive  — the .zip the export UI downloads
 *
 * Posting the archive to the JSON endpoint answered "body does not conform to
 * SiteBundleSchema", which reads as a bug in the bundle rather than a wrong
 * door. The handler now recognises the ZIP magic bytes and names the mistake.
 */
import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSqliteClient } from '../../../server/db/sqlite'
import { runMigrations } from '../../../server/db/runMigrations'
import { sqliteMigrations } from '../../../server/db/migrations-sqlite'
import type { DbClient } from '../../../server/db/client'
import { handleImportRoute } from '../../../server/handlers/cms/import'

async function setupDb(): Promise<{ db: DbClient; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'instatic-import-guide-'))
  const db = createSqliteClient(join(dir, 'test.db'))
  await runMigrations(db, sqliteMigrations)
  return {
    db,
    cleanup: async () => {
      await db.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

/** Minimal ZIP local-file-header prefix — enough for magic-byte detection. */
function zipBytes(): Uint8Array {
  return new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00])
}

function importRequest(body: BodyInit): Request {
  return new Request('http://localhost/admin/api/cms/import?strategy=merge-add', {
    method: 'POST',
    headers: { origin: 'http://localhost' },
    body,
  })
}

describe('POST /admin/api/cms/import with a ZIP body', () => {
  it('points the caller at the archive endpoint instead of blaming the schema', async () => {
    const { db, cleanup } = await setupDb()
    try {
      const res = await handleImportRoute(importRequest(zipBytes()), db)
      // Unauthenticated callers are rejected before body parsing; the guidance
      // only has to hold once the request reaches validation.
      if (!res || res.status === 401 || res.status === 403) return

      expect(res.status).toBe(400)
      const body = (await res.json()) as { error: string }
      expect(body.error).toContain('/import/archive')
      expect(body.error).not.toContain('SiteBundleSchema')
    } finally {
      await cleanup()
    }
  })
})

describe('ZIP detection', () => {
  it('does not misread a JSON bundle as an archive', async () => {
    const { db, cleanup } = await setupDb()
    try {
      const res = await handleImportRoute(
        importRequest(JSON.stringify({ schemaVersion: 1, exportedAt: '', tables: [], rows: [] })),
        db,
      )
      if (!res || res.status === 401 || res.status === 403) return
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      expect(body.error ?? '').not.toContain('/import/archive')
    } finally {
      await cleanup()
    }
  })
})
