import { nanoid } from 'nanoid'
import type { PublishedFormSnapshot } from '@core/forms'
import type { StoredRowAttachment } from '../repositories/rowAttachments'
import { validateAttachmentBytes, FormAttachmentError } from '../media/attachmentValidation'

export async function prepareFormAttachments(snapshot: PublishedFormSnapshot, files: Map<string, File[]>, values: Record<string, unknown>): Promise<StoredRowAttachment[]> {
  const attachments: StoredRowAttachment[] = []
  const controls = snapshot.controls.filter((control) => control.inputType === 'file')
  for (const name of files.keys()) {
    if (!controls.some((control) => (control.name ?? control.fieldId) === name)) {
      throw new FormAttachmentError('Unknown file input.')
    }
  }
  for (const control of controls) {
    const name = control.name ?? control.fieldId
    if (name.length > 200) throw new FormAttachmentError('File input names must be 200 characters or fewer.')
    if (snapshot.controls.filter((candidate) => (candidate.name ?? candidate.fieldId) === name).length !== 1) {
      throw new FormAttachmentError('File inputs must have unique names.')
    }
    if (Object.hasOwn(values, name)) throw new FormAttachmentError('Choose a file to upload; filenames and file IDs are not accepted.')
    const submitted = files.get(name) ?? []
    if (control.required && !submitted.length) throw new FormAttachmentError('A required attachment is missing.')
    if (!control.multiple && submitted.length > 1) throw new FormAttachmentError('Choose only one file for this input.')
    for (const file of submitted) {
      const filename = Array.from(file.name.split(/[\\/]/).at(-1) ?? '').filter((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127).join('').trim().slice(0, 255)
      const bytes = new Uint8Array(await file.arrayBuffer())
      const mimeType = validateAttachmentBytes(bytes, filename)
      attachments.push({ id: nanoid(), name, filename, mimeType, sizeBytes: bytes.length, bytes })
    }
  }
  return attachments
}
