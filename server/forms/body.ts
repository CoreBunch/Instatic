import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_ROW, MAX_TOTAL_ATTACHMENT_BYTES } from '@core/data/attachments'
import { PublicFormSubmitBodySchema } from '@core/forms'
import { safeParseJson } from '@core/utils/jsonValidate'
import type { Static } from '@sinclair/typebox'
import { readBodyBytesWithLimit, readValidatedBody, RequestBodyTooLargeError } from '../http'

export const FORM_MAX_FILE_BYTES = MAX_ATTACHMENT_BYTES
export const FORM_MAX_FILES = MAX_ATTACHMENTS_PER_ROW
export const FORM_MAX_TOTAL_FILE_BYTES = MAX_TOTAL_ATTACHMENT_BYTES
const MAX_METADATA_BYTES = 1024 * 1024
// Includes metadata, file bytes, multipart boundaries and per-part headers.
export const FORM_MAX_BODY_BYTES = FORM_MAX_TOTAL_FILE_BYTES + MAX_METADATA_BYTES + 64 * 1024

export interface FormSubmissionBody {
  body: Static<typeof PublicFormSubmitBodySchema>
  files: Map<string, File[]>
}

/** Parse the transport only. Published controls decide which files are accepted. */
export async function readFormSubmissionBody(req: Request): Promise<FormSubmissionBody | null> {
  const contentType = req.headers.get('content-type') ?? ''
  if (contentType.split(';', 1)[0]?.trim().toLowerCase() !== 'multipart/form-data') {
    const body = await readValidatedBody(req, PublicFormSubmitBodySchema, { maxBytes: MAX_METADATA_BYTES })
    return body ? { body, files: new Map() } : null
  }

  const bytes = await readBodyBytesWithLimit(req, FORM_MAX_BODY_BYTES)
  let form: FormData
  try {
    form = await new Request(req.url, {
      method: 'POST', headers: { 'content-type': contentType }, body: bytes,
    }).formData()
  } catch (_err) {
    // Invalid boundaries or malformed parts are invalid input, not server errors.
    return null
  }
  const payloads = form.getAll('payload')
  const payload = payloads[0]
  if (payloads.length !== 1 || typeof payload !== 'string') return null
  if (new TextEncoder().encode(payload).byteLength > MAX_METADATA_BYTES) {
    throw new RequestBodyTooLargeError(MAX_METADATA_BYTES)
  }
  const parsed = safeParseJson(payload, PublicFormSubmitBodySchema)
  if (!parsed.ok) return null

  const files = new Map<string, File[]>()
  let fileCount = 0
  let totalBytes = 0
  for (const key of new Set(form.keys())) {
    if (key === 'payload') continue
    if (!key.startsWith('file.') || key.length === 5) return null
    const name = key.slice(5)
    if (Object.hasOwn(parsed.value.values, name)) return null
    for (const file of form.getAll(key)) {
      if (typeof file === 'string') return null
      // Browsers represent an untouched optional file picker with an empty File.
      if (!file.name && file.size === 0) continue
      fileCount += 1
      totalBytes += file.size
      if (fileCount > FORM_MAX_FILES) return null
      if (file.size > FORM_MAX_FILE_BYTES) throw new RequestBodyTooLargeError(FORM_MAX_FILE_BYTES)
      if (totalBytes > FORM_MAX_TOTAL_FILE_BYTES) throw new RequestBodyTooLargeError(FORM_MAX_TOTAL_FILE_BYTES)
      const entries = files.get(name) ?? []
      entries.push(file)
      files.set(name, entries)
    }
  }
  return { body: parsed.value, files }
}
