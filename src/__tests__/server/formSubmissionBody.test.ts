import { describe, expect, it } from 'bun:test'
import { FORM_MAX_BODY_BYTES, FORM_MAX_FILE_BYTES, readFormSubmissionBody } from '../../../server/forms/body'
import { RequestBodyTooLargeError } from '../../../server/http'

const payload = { pageId: 'page', formId: 'contact', token: 'token', challenge: 'challenge', values: { name: 'Visitor' } }

function multipart(parts: Array<[string, string | File]>): Request {
  const form = new FormData()
  for (const [name, value] of parts) form.append(name, value)
  return new Request('http://localhost/_instatic/form/submit', { method: 'POST', body: form })
}

function withFile(file: File): Request {
  return multipart([['payload', JSON.stringify(payload)], ['file.attachment', file]])
}

describe('public form submission transport', () => {
  it('preserves binary bytes, filenames, repeated files and normal field values', async () => {
    const bytes = new Uint8Array([0, 255, 13, 10, 128, 1])
    const result = await readFormSubmissionBody(multipart([
      ['payload', JSON.stringify(payload)],
      ['file.attachment', new File([bytes], 'invoice.pdf', { type: 'application/pdf' })],
      ['file.attachment', new File(['second'], 'second.txt')],
    ]))
    expect(result?.body).toEqual(payload)
    const files = result?.files.get('attachment')
    expect(files?.map((file) => file.name)).toEqual(['invoice.pdf', 'second.txt'])
    expect(new Uint8Array(await files![0]!.arrayBuffer())).toEqual(bytes)
  })

  it('continues accepting validated JSON for submissions without files', async () => {
    const result = await readFormSubmissionBody(new Request('http://localhost/', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    }))
    expect(result?.body).toEqual(payload)
    expect(result?.files.size).toBe(0)
  })

  it('rejects duplicate or invalid metadata and unexpected parts', async () => {
    const valid: [string, string] = ['payload', JSON.stringify(payload)]
    for (const parts of [
      [valid, valid],
      [['payload', '{}']],
      [valid, ['extra', 'value']],
      [valid, ['file.attachment', 'invoice.pdf']],
      [valid, ['file.', new File(['bytes'], 'invoice.pdf')]],
      [valid, ['file.name', new File(['bytes'], 'invoice.pdf')]],
    ] satisfies Array<Array<[string, string | File]>>) {
      expect(await readFormSubmissionBody(multipart(parts))).toBeNull()
    }
  })

  it('does not count an untouched optional file picker as an upload', async () => {
    expect((await readFormSubmissionBody(withFile(new File([], ''))))?.files.size).toBe(0)
  })

  it('rejects more than five files and enforces individual and aggregate byte limits', async () => {
    const parts: Array<[string, string | File]> = [['payload', JSON.stringify(payload)]]
    for (let i = 0; i < 6; i++) parts.push(['file.attachment', new File(['x'], `${i}.txt`)])
    expect(await readFormSubmissionBody(multipart(parts))).toBeNull()
    await expect(readFormSubmissionBody(withFile(new File([new Uint8Array(FORM_MAX_FILE_BYTES + 1)], 'large.pdf'))))
      .rejects.toBeInstanceOf(RequestBodyTooLargeError)
    const large = new File([new Uint8Array(FORM_MAX_FILE_BYTES)], 'large.pdf')
    await expect(readFormSubmissionBody(multipart([
      ['payload', JSON.stringify(payload)], ['file.a', large], ['file.b', large],
      ['file.c', new File(['x'], 'last.txt')],
    ]))).rejects.toBeInstanceOf(RequestBodyTooLargeError)
  })

  it('caps a chunked request even when its Content-Length understates the body', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(FORM_MAX_BODY_BYTES + 1)) },
      cancel() { cancelled = true },
    })
    const req = new Request('http://localhost/', { method: 'POST', body })
    req.headers.set('content-type', 'multipart/form-data; boundary=test')
    req.headers.set('content-length', '1')
    await expect(readFormSubmissionBody(req)).rejects.toBeInstanceOf(RequestBodyTooLargeError)
    expect(cancelled).toBe(true)
  })
})
