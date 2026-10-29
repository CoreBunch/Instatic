import { attachmentKey, MAX_ATTACHMENTS_PER_ROW, MAX_TOTAL_ATTACHMENT_BYTES, type BundleAttachment } from '@core/data/attachments'
import { physicalId } from '@core/branches'
import { validateAttachmentBytes, FormAttachmentError } from '../media/attachmentValidation'
import { insertRowAttachments, type StoredRowAttachment } from './rowAttachments'
import type { DbClient } from '../db/client'
import type { BranchScope } from '../branches/scope'

export class BundleAttachmentError extends Error {}

export function prepareBundleAttachments(
  attachments: readonly BundleAttachment[],
  rowIds: ReadonlySet<string>,
  files: ReadonlyMap<string, Uint8Array>,
): Map<string, StoredRowAttachment[]> {
  const prepared = new Map<string, StoredRowAttachment[]>()
  const seen = new Set<string>()
  for (const file of attachments) {
    const key = attachmentKey(file.rowId, file.id)
    if (!rowIds.has(file.rowId) || seen.has(key)) throw new BundleAttachmentError('Invalid attachment row or duplicate attachment')
    seen.add(key)
    const bytes = files.get(key) ?? (file.bytesBase64 === undefined ? undefined : Buffer.from(file.bytesBase64, 'base64'))
    if (!bytes || bytes.length !== file.sizeBytes) throw new BundleAttachmentError('Missing or invalid attachment bytes')
    try {
      if (validateAttachmentBytes(bytes, file.filename) !== file.mimeType) throw new BundleAttachmentError('Attachment content type mismatch')
    } catch (err) {
      if (err instanceof FormAttachmentError) throw new BundleAttachmentError(err.message, { cause: err })
      throw err
    }
    const rowFiles = prepared.get(file.rowId) ?? []
    rowFiles.push({ id: file.id, name: file.name, filename: file.filename, mimeType: file.mimeType, sizeBytes: file.sizeBytes, bytes })
    if (rowFiles.length > MAX_ATTACHMENTS_PER_ROW || rowFiles.reduce((sum, item) => sum + item.sizeBytes, 0) > MAX_TOTAL_ATTACHMENT_BYTES) throw new BundleAttachmentError('Attachment limits exceeded')
    prepared.set(file.rowId, rowFiles)
  }
  return prepared
}

export async function restoreBundleAttachments(db: DbClient, scope: BranchScope, importedRowIds: ReadonlySet<string>, prepared: ReadonlyMap<string, StoredRowAttachment[]>): Promise<void> {
  for (const rowId of importedRowIds) {
    await db`delete from data_row_attachments where row_id = ${physicalId(scope.branchId, rowId)}`
    await insertRowAttachments(db, scope, rowId, prepared.get(rowId) ?? [])
  }
}
