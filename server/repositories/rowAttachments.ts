/** Private, immutable binaries shared by branch copies of their owning row. */
import { physicalId } from '@core/branches'
import type { RowAttachment, BundleAttachment } from '@core/data/attachments'
import type { DbClient } from '../db/client'
import type { BranchScope } from '../branches/scope'

export interface StoredRowAttachment extends RowAttachment { bytes: Uint8Array }
interface AttachmentRecord {
  id: string
  name: string
  filename: string
  mime_type: string
  size_bytes: number
  content_bytes: Uint8Array
}
export class AttachmentConflictError extends Error {}

export async function insertRowAttachments(db: DbClient, scope: BranchScope, rowId: string, attachments: readonly StoredRowAttachment[]): Promise<void> {
  for (const file of attachments) {
    await db`insert into data_attachments (id, owner_row_id, name, filename, mime_type, size_bytes, content_bytes)
      values (${file.id}, ${rowId}, ${file.name}, ${file.filename}, ${file.mimeType}, ${file.sizeBytes}, ${file.bytes}) on conflict (id) do nothing`
    const { rows } = await db<AttachmentRecord & { owner_row_id: string }>`select * from data_attachments where id = ${file.id}`
    const stored = rows[0]
    if (!stored || stored.owner_row_id !== rowId || stored.name !== file.name || stored.filename !== file.filename || stored.mime_type !== file.mimeType || stored.size_bytes !== file.sizeBytes || Buffer.compare(stored.content_bytes, file.bytes) !== 0) {
      throw new AttachmentConflictError('Attachment ID conflicts with an existing file')
    }
    await db`insert into data_row_attachments (row_id, attachment_id)
      values (${physicalId(scope.branchId, rowId)}, ${file.id}) on conflict (row_id, attachment_id) do nothing`
  }
}

export async function listRowAttachments(db: DbClient, scope: BranchScope, rowId: string): Promise<RowAttachment[]> {
  const { rows } = await db<Omit<AttachmentRecord, 'content_bytes'>>`
    select a.id, a.name, a.filename, a.mime_type, a.size_bytes from data_attachments a
    join data_row_attachments r on r.attachment_id = a.id
    where r.row_id = ${physicalId(scope.branchId, rowId)} order by a.id`
  return rows.map((row) => ({ id: row.id, name: row.name, filename: row.filename, mimeType: row.mime_type, sizeBytes: row.size_bytes }))
}

export async function getRowAttachment(db: DbClient, scope: BranchScope, rowId: string, id: string): Promise<StoredRowAttachment | null> {
  const { rows } = await db<AttachmentRecord>`select a.id, a.name, a.filename, a.mime_type, a.size_bytes, a.content_bytes
    from data_attachments a join data_row_attachments r on r.attachment_id = a.id
    where r.row_id = ${physicalId(scope.branchId, rowId)} and a.id = ${id}`
  const row = rows[0]
  return row ? { id: row.id, name: row.name, filename: row.filename, mimeType: row.mime_type, sizeBytes: row.size_bytes, bytes: row.content_bytes } : null
}

/** Merge keeps existing immutable files; references cannot cross logical row owners. */
export async function replaceRowAttachmentLinks(db: DbClient, scope: BranchScope, rowId: string, ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    const { rows } = await db`select id from data_attachments where id = ${id} and owner_row_id = ${rowId}`
    if (!rows.length) throw new AttachmentConflictError('Attachment is unavailable for this row')
    await db`insert into data_row_attachments (row_id, attachment_id)
      values (${physicalId(scope.branchId, rowId)}, ${id}) on conflict (row_id, attachment_id) do nothing`
  }
  for (const file of await listRowAttachments(db, scope, rowId)) {
    if (!ids.includes(file.id)) await db`delete from data_row_attachments where row_id = ${physicalId(scope.branchId, rowId)} and attachment_id = ${file.id}`
  }
}

export async function copyRowAttachments(db: DbClient, from: BranchScope, to: BranchScope, rowId: string): Promise<void> {
  await db`insert into data_row_attachments (row_id, attachment_id)
    select ${physicalId(to.branchId, rowId)}, attachment_id
    from data_row_attachments where row_id = ${physicalId(from.branchId, rowId)}`
}

export async function exportRowAttachments(db: DbClient, scope: BranchScope, rowIds: readonly string[]): Promise<{ attachments: BundleAttachment[]; bytes: Uint8Array[] }> {
  const attachments: BundleAttachment[] = []
  const bytes: Uint8Array[] = []
  for (const rowId of rowIds) {
    for (const metadata of await listRowAttachments(db, scope, rowId)) {
      const file = await getRowAttachment(db, scope, rowId, metadata.id)
      if (!file) throw new Error('Attachment disappeared during export')
      attachments.push({ rowId, ...metadata })
      bytes.push(file.bytes)
    }
  }
  return { attachments, bytes }
}
