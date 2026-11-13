import type { DbClient } from '../../../server/db/client'
import { forkBranch } from '../../../server/branches/fork'
import { applyBranchMerge, undoBranchMerge } from '../../../server/branches/merge'
import { deleteBranch } from '../../../server/branches/deleteBranch'
import { replaceRowAttachmentLinks } from '../../../server/repositories/rowAttachments'
import { expect, test } from 'bun:test'
import { createCapabilityTestHarness } from '../helpers/capabilityHarness'
import { makeSite, makePage, makeNode } from '../fixtures'
import { saveDraftSite } from '../../../server/repositories/site'
import { createDataTable, createDataRow, listDataRows, softDeleteDataRow } from '../../../server/repositories/data'
import { pageToCells } from '@core/data/pageFromRow'
import { MAIN_SCOPE } from '../../../server/branches/scope'
import { publishDraftSite } from '../../../server/publish/publishSite'
import { handlePublicFormRequest } from '../../../server/forms/handler'
import { issuePublicFormChallenge, resetPublicFormChallenges } from '../../../server/forms/challenge'
import { publicFormPerIpRateLimit, publicFormPerFormRateLimit } from '../../../server/forms/rateLimit'
import { listRowAttachments, getRowAttachment } from '../../../server/repositories/rowAttachments'
import { handleExportRoute } from '../../../server/handlers/cms/export'
import { handleImportArchiveRoute } from '../../../server/handlers/cms/importArchive'
import { parseSiteBundleArchive } from '@core/persistence/cmsTransfer'
import { physicalId } from '@core/branches'
import '@modules/base'

const pdf = new TextEncoder().encode('%PDF-1.7\nPrivate invoice\n%%EOF')

test('private form files survive submit, access checks and ZIP restore; failed submissions leave no files', async () => {
  const h = await createCapabilityTestHarness()
  try {
    let cookie = await h.setupOwner()
    const table = await createDataTable(h.db, MAIN_SCOPE, { name: 'Submissions', slug: 'submissions', singularLabel: 'Submission', pluralLabel: 'Submissions', fields: [{ id: 'email', label: 'Email', type: 'email', required: true }] })
    const page = makePage({ id: 'file-form', slug: 'attachments', nodes: {
      root: makeNode({ id: 'root', moduleId: 'base.body', children: ['form'] }),
      form: makeNode({ id: 'form', moduleId: 'base.form', props: { mode: 'cms', formId: 'files', targetTableId: table.id, minSubmitSeconds: 0 }, children: ['email', 'upload'] }),
      email: makeNode({ id: 'email', moduleId: 'base.input', props: { inputType: 'email', fieldId: 'email', name: 'email', required: true } }),
      upload: makeNode({ id: 'upload', moduleId: 'base.input', props: { inputType: 'file', name: 'attachment', required: true } }),
    } })
    await saveDraftSite(h.db, MAIN_SCOPE, makeSite())
    await createDataRow(h.db, MAIN_SCOPE, { id: page.id, tableId: 'pages', cells: pageToCells(page), slug: page.slug })
    await publishDraftSite(h.db, null)
    async function submit(file: File | null, email = 'visitor@example.test', name = 'attachment', values: Record<string, unknown> = {}, db = h.db) {
      const challenge = issuePublicFormChallenge({ pageId: page.id, formId: 'files' })
      const body = new FormData()
      body.append('payload', JSON.stringify({ pageId: page.id, formId: 'files', token: challenge.token, challenge: challenge.challenge, values: { email, ...values } }))
      if (file) body.append(`file.${name}`, file)
      const req = new Request('http://localhost/_instatic/form/submit', { method: 'POST', body })
      req.headers.set('origin', 'http://localhost')
      return (await handlePublicFormRequest(req, db, new URL(req.url)))!
    }
    const accepted = await submit(new File([pdf], 'invoice.pdf', { type: 'text/html' }))
    expect(accepted.status, await accepted.clone().text()).toBe(200)
    const rows = await listDataRows(h.db, MAIN_SCOPE, table.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].cells).toEqual({ email: 'visitor@example.test' })
    const files = await listRowAttachments(h.db, MAIN_SCOPE, rows[0].id)
    expect(files).toHaveLength(1)
    expect(files[0].filename).toBe('invoice.pdf')
    expect(files[0].mimeType).toBe('application/pdf')
    const path = `/admin/api/cms/data/rows/${rows[0].id}/attachments/${files[0].id}`
    const downloaded = await h.cms(path, { cookie })
    expect(downloaded.status).toBe(200)
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(pdf)
    expect(downloaded.headers.get('content-disposition')).toStartWith('attachment;')
    expect(downloaded.headers.get('cache-control')).toContain('no-store')
    expect((await h.cms(path)).status).toBe(401)
    const own = await h.createRoleUser({ name: 'Own files', slug: 'own-files', capabilities: ['content.edit.own', 'data.custom.tables.read'] })
    expect((await h.cms(path, { cookie: own.cookie })).status).toBe(404)
    const mediaOnly = await h.createRoleUser({ name: 'Media reader', slug: 'media-only', capabilities: ['media.read'] })
    expect((await h.cms(path, { cookie: mediaOnly.cookie })).status).toBe(403)
    const differentRow = await createDataRow(h.db, MAIN_SCOPE, { tableId: table.id, cells: {}, slug: '' })
    expect((await h.cms(path.replace(rows[0].id, differentRow.id), { cookie })).status).toBe(404)
    for (const response of [
      await submit(new File(['<script>bad</script>'], 'fake.pdf')),
      await submit(new File([pdf], 'invoice.pdf'), 'invalid email'),
      await submit(new File([pdf], 'invoice.pdf'), 'a@example.test', 'unknown'),
      await submit(null),
      await submit(null, 'a@example.test', 'attachment', { attachment: files[0].id }),
    ]) expect(response.status, await response.text()).toBe(400)
    const failingDb = new Proxy(h.db, {
      get(target, property) {
        if (property !== 'transaction') return Reflect.get(target, property)
        return <T>(operation: (tx: DbClient) => Promise<T>) => target.transaction((tx) => operation(new Proxy(tx, {
          apply(query, receiver, args) {
            if (String(args[0]).includes('insert into data_attachments')) throw new Error('Simulated attachment storage failure')
            return Reflect.apply(query, receiver, args)
          },
        })))
      },
    })
    await expect(submit(new File([pdf], 'invoice.pdf'), 'retry@example.test', 'attachment', {}, failingDb)).rejects.toThrow('Simulated attachment storage failure')
    expect(await listDataRows(h.db, MAIN_SCOPE, table.id)).toHaveLength(2)
    expect((await h.db`select attachment_id from data_row_attachments`).rows).toHaveLength(1)
    const exportReq = new Request('http://localhost/admin/api/cms/export')
    exportReq.headers.set('cookie', cookie)
    const exported = await handleExportRoute(exportReq, h.db, MAIN_SCOPE)
    expect(exported?.status).toBe(200)
    const archive = await exported!.arrayBuffer()
    const manifest = parseSiteBundleArchive(new Uint8Array(archive))
    expect(manifest.attachments?.[0].filename).toBe('invoice.pdf')
    await h.db`delete from data_rows where id = ${physicalId(MAIN_SCOPE.branchId, rows[0].id)}`
    expect((await h.db`select attachment_id from data_row_attachments`).rows).toHaveLength(0)
    const importReq = new Request('http://localhost/admin/api/cms/import/archive?strategy=replace', { method: 'POST', body: archive })
    cookie = await h.stepUp(cookie)
    importReq.headers.set('cookie', cookie)
    const restored = await handleImportArchiveRoute(importReq, h.db, MAIN_SCOPE)
    expect(restored?.status, await restored?.text()).toBe(200)
    expect((await getRowAttachment(h.db, MAIN_SCOPE, rows[0].id, files[0].id))?.bytes).toEqual(pdf)
    expect((await h.cms(path)).status).toBe(401)
    await forkBranch(h.db, { id: 'file-review', name: 'File review', fromBranchId: 'main', createdByUserId: null })
    expect((await getRowAttachment(h.db, { branchId: 'file-review' }, rows[0].id, files[0].id))?.bytes).toEqual(pdf)
    await h.db.transaction((tx) => replaceRowAttachmentLinks(tx, { branchId: 'file-review' }, rows[0].id, []))
    await applyBranchMerge(h.db, { branchId: 'file-review', direction: 'merge', resolutions: {}, actorUserId: null })
    expect(await listRowAttachments(h.db, MAIN_SCOPE, rows[0].id)).toHaveLength(0)
    await undoBranchMerge(h.db, { branchId: 'file-review', direction: 'merge', actorUserId: null })
    expect((await getRowAttachment(h.db, MAIN_SCOPE, rows[0].id, files[0].id))?.bytes).toEqual(pdf)
    await deleteBranch(h.db, 'file-review', null)
    await softDeleteDataRow(h.db, MAIN_SCOPE, rows[0].id)
    expect((await h.cms(path, { cookie })).status).toBe(404)
    await h.db`delete from data_rows where id = ${physicalId(MAIN_SCOPE.branchId, rows[0].id)}`
    expect((await h.db`select id from data_attachments`).rows).toHaveLength(0)
  } finally {
    publicFormPerIpRateLimit.reset('unknown')
    publicFormPerFormRateLimit.reset('unknown|files')
    resetPublicFormChallenges()
    await h.cleanup()
  }
}, 30000)
