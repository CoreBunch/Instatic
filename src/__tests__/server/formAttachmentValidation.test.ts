import { expect, test } from 'bun:test'
import { validateAttachmentBytes } from '../../../server/media/attachmentValidation'
import { prepareFormAttachments } from '../../../server/forms/attachments'
import type { PublishedFormSnapshot } from '@core/forms'

const pdf = new TextEncoder().encode('%PDF-1.7\nattachment\n%%EOF')
const snapshot: PublishedFormSnapshot = {
  pageId: 'page', nodeId: 'form', formId: 'form', targetTableId: 'submissions', honeypotName: 'bot', minSubmitSeconds: 0,
  controls: [{ nodeId: 'upload', fieldId: 'upload', name: 'file', inputType: 'file', required: true }],
  labels: [], submits: [], messages: [],
}

test('attachment type checks reject active formats, binary text, empty files and forged extensions', () => {
  expect(validateAttachmentBytes(pdf, 'invoice.PDF')).toBe('application/pdf')
  expect(validateAttachmentBytes(new TextEncoder().encode('Hello\n'), 'note.txt')).toBe('text/plain')
  for (const [bytes, filename] of [
    [pdf, 'invoice.html'], [new Uint8Array(), 'empty.pdf'],
    [new TextEncoder().encode('<svg/>'), 'image.svg'], [new Uint8Array([0, 255]), 'binary.txt'],
    [pdf, 'invoice.png'],
  ] as const) expect(() => validateAttachmentBytes(bytes, filename)).toThrow()
})

test('published file controls enforce required, multiple, unique names and server-generated references', async () => {
  const file = new File([pdf], 'invoice.pdf')
  await expect(prepareFormAttachments(snapshot, new Map(), {})).rejects.toThrow('required')
  await expect(prepareFormAttachments(snapshot, new Map([['file', [file, file]]]), {})).rejects.toThrow('only one')
  await expect(prepareFormAttachments(snapshot, new Map([['unknown', [file]]]), {})).rejects.toThrow('Unknown')
  await expect(prepareFormAttachments(snapshot, new Map(), { file: 'other-row-file-id' })).rejects.toThrow('IDs')
  await expect(prepareFormAttachments({ ...snapshot, controls: [...snapshot.controls, snapshot.controls[0]] }, new Map([['file', [file]]]), {})).rejects.toThrow('unique')
  const multi = { ...snapshot, controls: snapshot.controls.map((control) => ({ ...control, multiple: true })) }
  const files = await prepareFormAttachments(multi, new Map([['file', [file, file]]]), {})
  expect(files).toHaveLength(2)
  expect(files[0].id).not.toBe(files[1].id)
  expect(files[0].bytes).toEqual(pdf)
  expect(await prepareFormAttachments({ ...snapshot, controls: snapshot.controls.map((control) => ({ ...control, required: false })) }, new Map(), {})).toEqual([])
})
