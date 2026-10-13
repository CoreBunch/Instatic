/**
 * Content keys for fragment media: the SHA-256 of the bytes, and the path a
 * fragment package stores those bytes under (`media/<key>.<ext>`).
 *
 * Uses Web Crypto, which Bun, Node 20+ and every browser expose as
 * `crypto.subtle`, so the same code hashes in the editor and in a build script.
 */

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'font/woff2': 'woff2',
  'font/woff': 'woff',
  'font/ttf': 'ttf',
  'font/otf': 'otf',
  'application/pdf': 'pdf',
}

/** `media/<key>.<ext>` — the extension from the filename, else the MIME type. */
export function mediaPackagePath(key: string, filename: string, mimeType: string): string {
  const fromName = /\.([A-Za-z0-9]{1,8})$/.exec(filename)?.[1]?.toLowerCase()
  const ext = fromName ?? EXTENSION_BY_MIME[mimeType] ?? 'bin'
  return `media/${key}.${ext}`
}
