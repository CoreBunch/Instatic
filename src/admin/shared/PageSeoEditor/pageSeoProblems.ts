/**
 * Field-local validation for the page head settings editor: the reasons a
 * draft cannot be saved, shared by the field rows and the dialog's Save gate.
 */
import { RESERVED_PAGE_META_NAMES, type PageHeadMeta, type PageSeo } from '@core/page-tree'

const META_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]*$/

export function metaNameProblem(entry: PageHeadMeta): string | null {
  const name = entry.name.trim()
  if (!name && !entry.content.trim()) return null
  if (!name) return 'Give the tag a name.'
  if (!META_NAME_RE.test(name)) return 'Names use letters, digits, and : . _ - only.'
  if (RESERVED_PAGE_META_NAMES.has(name.toLowerCase())) return `Set ${name} with its own field instead.`
  return null
}

export function jsonLdProblem(text: string): string | null {
  if (!text.trim()) return null
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? null : 'Structured data must be a JSON object or array.'
  } catch (_err) {
    // The parse error itself is noise to an author; the fix is the same.
    return 'This is not valid JSON.'
  }
}

/** The first reason the draft cannot be saved, or null. */
export function pageSeoProblem(value: PageSeo): string | null {
  for (const entry of value.meta ?? []) {
    const problem = metaNameProblem(entry)
    if (problem) return `Meta tag: ${problem}`
  }
  for (const block of value.jsonLd ?? []) {
    const problem = jsonLdProblem(block)
    if (problem) return `Structured data: ${problem}`
  }
  return null
}
