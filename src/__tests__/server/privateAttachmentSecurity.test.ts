import { expect, test } from 'bun:test'
import { createCapabilityTestHarness } from '../helpers/capabilityHarness'
import { createDataTable, createDataRow, getDataRow } from '../../../server/repositories/data'
import { insertRowAttachments, getRowAttachment, listRowAttachments } from '../../../server/repositories/rowAttachments'
import { findUserByEmail } from '../../../server/repositories/users'
import { forkBranch } from '../../../server/branches/fork'
import { MAIN_SCOPE } from '../../../server/branches/scope'
import { parseSiteBundleArchive } from '@core/persistence/cmsTransfer'
import type { DbClient } from '../../../server/db/client'
import { handleExportRoute } from '../../../server/handlers/cms/export'

test('ZIP export cannot bypass private attachment table permissions', async () => {
  const h = await createCapabilityTestHarness()
  try {
    const owner = await h.setupOwner()
    const table = await createDataTable(h.db, MAIN_SCOPE, {
      name: 'Private submissions', slug: 'private-submissions', singularLabel: 'Submission', pluralLabel: 'Submissions', fields: [],
    })
    const row = await createDataRow(h.db, MAIN_SCOPE, { tableId: table.id, cells: {}, slug: '' })
    const bytes = new TextEncoder().encode('Private submission contents')
    await h.db.transaction((tx) => insertRowAttachments(tx, MAIN_SCOPE, row.id, [{
      id: 'private-file', name: 'document', filename: 'private.txt', mimeType: 'text/plain', sizeBytes: bytes.length, bytes,
    }]))
    const restricted = await h.createRoleUser({
      name: 'System exporter', slug: 'system-exporter',
      capabilities: ['data.export', 'content.edit.any', 'data.system.tables.read'],
    })
    const path = `/admin/api/cms/data/rows/${row.id}/attachments/private-file`
    expect((await h.cms(path, { cookie: restricted.cookie })).status).toBe(404)
    for (const request of [
      { method: 'GET' },
      { method: 'POST', json: { tables: [{ tableId: table.id, rowIds: [row.id] }], includeSite: false } },
    ]) {
      const response = await h.cms('/admin/api/cms/export', { ...request, cookie: restricted.cookie })
      expect(response.status).toBe(200)
      const bundle = parseSiteBundleArchive(new Uint8Array(await response.arrayBuffer()))!
      expect(bundle.attachments).toEqual([])
      expect(bundle.rows.some((entry) => entry.id === row.id)).toBe(false)
    }
    const allowed = await h.cms('/admin/api/cms/export', { cookie: owner })
    const bundle = parseSiteBundleArchive(new Uint8Array(await allowed.arrayBuffer()))!
    expect(bundle.attachments?.[0].bytesBase64).toBe(Buffer.from(bytes).toString('base64'))
  } finally {
    await h.cleanup()
  }
})

test('export requires row read rights even for rows created by the caller', async () => {
  const h = await createCapabilityTestHarness()
  try {
    await h.setupOwner()
    const exporter = await h.createRoleUser({
      name: 'Export without content read', slug: 'export-no-read', capabilities: ['data.export', 'data.custom.tables.read'],
    })
    const user = (await findUserByEmail(h.db, exporter.email))!
    const table = await createDataTable(h.db, MAIN_SCOPE, {
      name: 'Submissions', slug: 'submissions', singularLabel: 'Submission', pluralLabel: 'Submissions', fields: [],
    })
    const row = await createDataRow(h.db, MAIN_SCOPE, { tableId: table.id, cells: {}, slug: '' }, user.id)
    const bytes = new TextEncoder().encode('Private')
    await h.db.transaction((tx) => insertRowAttachments(tx, MAIN_SCOPE, row.id, [{
      id: 'private-file', name: 'document', filename: 'private.txt', mimeType: 'text/plain', sizeBytes: bytes.length, bytes,
    }]))
    expect((await h.cms(`/admin/api/cms/data/rows/${row.id}/attachments`, { cookie: exporter.cookie })).status).toBe(403)
    const response = await h.cms('/admin/api/cms/export', { cookie: exporter.cookie })
    expect(response.status).toBe(200)
    const bundle = parseSiteBundleArchive(new Uint8Array(await response.arrayBuffer()))!
    expect(bundle.rows).toEqual([])
    expect(bundle.attachments).toEqual([])
  } finally {
    await h.cleanup()
  }
})

test('forged restores cannot change immutable bytes, reassign files, or link an ID without its bytes', async () => {
  const h = await createCapabilityTestHarness()
  try {
    const owner = await h.setupOwner()
    const table = await createDataTable(h.db, MAIN_SCOPE, {
      name: 'Submissions', slug: 'submissions', singularLabel: 'Submission', pluralLabel: 'Submissions',
      fields: [{ id: 'message', label: 'Message', type: 'text' }],
    })
    const row = await createDataRow(h.db, MAIN_SCOPE, { tableId: table.id, cells: { message: 'Original' }, slug: '' })
    const other = await createDataRow(h.db, MAIN_SCOPE, { tableId: table.id, cells: { message: 'Other' }, slug: '' })
    const bytes = new TextEncoder().encode('Private')
    const metadata = { id: 'private-file', name: 'document', filename: 'private.txt', mimeType: 'text/plain', sizeBytes: bytes.length }
    await h.db.transaction((tx) => insertRowAttachments(tx, MAIN_SCOPE, row.id, [{ ...metadata, bytes }]))
    await forkBranch(h.db, { id: 'review', name: 'Review', fromBranchId: 'main', createdByUserId: null })
    for (const attachment of [
      { ...metadata, rowId: row.id, bytesBase64: Buffer.from('Changed').toString('base64') },
      { ...metadata, rowId: other.id, bytesBase64: Buffer.from(bytes).toString('base64') },
      { ...metadata, rowId: row.id },
    ]) {
      const response = await h.cms('/admin/api/cms/import?strategy=merge-overwrite', {
        method: 'POST', cookie: owner,
        json: { schemaVersion: 1, exportedAt: new Date().toISOString(), tables: [table], rows: [{ ...row, cells: { message: 'Changed' } }, other], attachments: [attachment] },
      })
      expect(response.status, await response.clone().text()).toBe(400)
      expect((await getDataRow(h.db, MAIN_SCOPE, row.id))?.cells).toEqual({ message: 'Original' })
      expect((await getRowAttachment(h.db, MAIN_SCOPE, row.id, metadata.id))?.bytes).toEqual(bytes)
      expect((await getRowAttachment(h.db, { branchId: 'review' }, row.id, metadata.id))?.bytes).toEqual(bytes)
      expect(await listRowAttachments(h.db, MAIN_SCOPE, other.id)).toEqual([])
    }
  } finally {
    await h.cleanup()
  }
})

test('archive size estimates do not load private binaries and match the download size', async () => {
  const h = await createCapabilityTestHarness()
  try {
    const owner = await h.setupOwner()
    const table = await createDataTable(h.db, MAIN_SCOPE, {
      name: 'Submissions', slug: 'submissions', singularLabel: 'Submission', pluralLabel: 'Submissions', fields: [],
    })
    const row = await createDataRow(h.db, MAIN_SCOPE, { tableId: table.id, cells: {}, slug: '' })
    const bytes = new TextEncoder().encode('Private')
    await h.db.transaction((tx) => insertRowAttachments(tx, MAIN_SCOPE, row.id, [{
      id: 'private-file', name: 'document', filename: 'private.txt', mimeType: 'text/plain', sizeBytes: bytes.length, bytes,
    }]))
    let binaryReads = 0
    function trackReads(db: DbClient): DbClient {
      return new Proxy(db, {
        apply(query, receiver, args) {
          if (String(args[0]).includes('content_bytes')) binaryReads++
          return Reflect.apply(query, receiver, args)
        },
        get(target, property) {
          if (property === 'transaction') return <T>(fn: (tx: DbClient) => Promise<T>) => target.transaction((tx) => fn(trackReads(tx)))
          return Reflect.get(target, property)
        },
      })
    }
    const request = new Request('http://localhost/admin/api/cms/export/estimate')
    request.headers.set('cookie', owner)
    const estimate = await handleExportRoute(request, trackReads(h.db), MAIN_SCOPE)
    expect(estimate?.status).toBe(200)
    expect(binaryReads).toBe(0)
    const download = await h.cms('/admin/api/cms/export', { cookie: owner })
    const archive = new Uint8Array(await download.arrayBuffer())
    expect((await estimate!.json()).bytes).toBe(archive.length)
    expect(parseSiteBundleArchive(archive)?.attachments?.[0].bytesBase64).toBe(Buffer.from(bytes).toString('base64'))
  } finally {
    await h.cleanup()
  }
})
