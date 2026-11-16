import { Type, type Static } from '@core/utils/typeboxHelpers'

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
export const MAX_ATTACHMENTS_PER_ROW = 5
export const MAX_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024

export const RowAttachmentSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1, maxLength: 200 }),
  filename: Type.String({ minLength: 1, maxLength: 255 }),
  mimeType: Type.String({ minLength: 1 }),
  sizeBytes: Type.Integer({ minimum: 1, maximum: MAX_ATTACHMENT_BYTES }),
})
export type RowAttachment = Static<typeof RowAttachmentSchema>
export const BundleAttachmentSchema = Type.Intersect([
  RowAttachmentSchema,
  Type.Object({ rowId: Type.String({ minLength: 1 }), bytesBase64: Type.Optional(Type.String()) }),
])
export type BundleAttachment = Static<typeof BundleAttachmentSchema>
export function attachmentArchivePath(index: number): string {
  return `attachments/${index}`
}

export function attachmentKey(rowId: string, id: string): string {
  return JSON.stringify([rowId, id])
}
