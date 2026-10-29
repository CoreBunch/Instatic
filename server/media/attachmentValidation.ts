import { detectAcceptedMime } from './fileTypes'
import { MAX_ATTACHMENT_BYTES } from '@core/data/attachments'

const TYPES: Record<string, string> = {
  pdf: 'application/pdf', txt: 'text/plain', png: 'image/png', jpg: 'image/jpeg',
  jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
}

export class FormAttachmentError extends Error {}

/** A download is always an attachment, never executable or inline public content. */
export function validateAttachmentBytes(bytes: Uint8Array, filename: string): string {
  if (!bytes.length || bytes.length > MAX_ATTACHMENT_BYTES) throw new FormAttachmentError('Files must be between 1 byte and 10 MB.')
  const extension = filename.split('.').at(-1)?.toLowerCase() ?? ''
  const expected = TYPES[extension]
  if (!expected) throw new FormAttachmentError('Upload a PDF, text, PNG, JPEG, GIF, or WebP file.')
  let detected: string | null = detectAcceptedMime(bytes)
  if (new TextDecoder().decode(bytes.subarray(0, 5)) === '%PDF-') detected = 'application/pdf'
  if (extension === 'txt') {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      if (bytes.some((byte) => byte < 32 && byte !== 9 && byte !== 10 && byte !== 13)) throw new Error('Binary text')
      detected = 'text/plain'
    } catch (_err) {
      throw new FormAttachmentError('Text attachments must contain UTF-8 text.')
    }
  }
  if (detected !== expected) throw new FormAttachmentError('The file contents do not match its extension.')
  return expected
}
