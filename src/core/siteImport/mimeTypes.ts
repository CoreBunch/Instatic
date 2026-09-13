/**
 * mimeTypes — lightweight extension-to-MIME mapping for the asset pipeline.
 *
 * Used when a FileMap entry has no MIME type (e.g. from a zip with no
 * metadata). Returns `'application/octet-stream'` as a safe fallback.
 */

const EXT_TO_MIME: Record<string, string> = {
  // Images
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  gif: 'image/gif',
  ico: 'image/x-icon',
  // Video
  mp4: 'video/mp4',
  webm: 'video/webm',
  // Fonts
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject',
  // Documents / data
  pdf: 'application/pdf',
  zip: 'application/zip',
  csv: 'text/csv',
  txt: 'text/plain',
  md: 'text/markdown',
  ini: 'text/plain',
  json: 'application/json',
  // Web
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  scss: 'text/x-scss',
  sass: 'text/x-sass',
  less: 'text/x-less',
  js: 'text/javascript',
  mjs: 'text/javascript',
  map: 'application/json',
  php: 'text/x-php',
}

const IMPORT_UPLOADABLE_MIME_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/svg+xml',
  'video/mp4',
  'video/webm',
  'font/woff',
  'font/woff2',
  'font/ttf',
  'font/otf',
])

/** Return a MIME type for the given file path based on its extension. */
export function guessMimeType(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase()
  return (ext && EXT_TO_MIME[ext]) ?? 'application/octet-stream'
}

/** Whether the site importer can upload this MIME through the CMS media endpoint. */
export function isImportUploadableMimeType(mimeType: string): boolean {
  return IMPORT_UPLOADABLE_MIME_TYPES.has(mimeType.toLowerCase().split(';', 1)[0].trim())
}
