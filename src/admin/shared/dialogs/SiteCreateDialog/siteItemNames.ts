export type SiteCreateKind = 'page' | 'component' | 'style' | 'script'

export function slugifySiteItemName(value: string, fallback = 'page') {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || fallback
}

function stripSitePrefix(value: string, prefix: string) {
  const trimmed = value.trim()
  // Plain string match — no RegExp, so the prefix's `/` (and any other regex
  // metacharacters) are treated literally (CodeQL js/incomplete-sanitization).
  return trimmed.startsWith(prefix) ? trimmed.slice(prefix.length) : trimmed
}

function ensureExtension(value: string, extension: string) {
  return value.endsWith(extension) ? value : `${value}${extension}`
}

export function buildStylePath(value: string) {
  const name = ensureExtension(stripSitePrefix(value, 'src/styles/'), '.css')
  return `src/styles/${name}`
}

export function buildScriptPath(value: string) {
  const name = ensureExtension(stripSitePrefix(value, 'src/scripts/'), '.ts')
  return `src/scripts/${name}`
}
