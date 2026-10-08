import { Value } from '@sinclair/typebox/value'
import { SiteFileBlobSchema, type SiteFile, type SiteFileBlob } from './schemas'
import { isSafePath } from './pathValidation'
import { isReservedPublicPath } from '../publicPaths'
import { checkSizeLimit } from './upload'

export class PublicAssetValidationError extends Error {
  readonly path: string

  constructor(path: string, message: string) {
    super(`${path}: ${message}`)
    this.name = 'PublicAssetValidationError'
    this.path = path
  }
}

/** A public file's URL; encode filenames once, independently of disk paths. */
export function publicAssetUrl(path: string): string {
  if (!isSafePath(path) || !path.startsWith('public/')) {
    throw new PublicAssetValidationError(path, 'Asset files must have a safe path under public/.')
  }
  const relativePath = path.slice('public/'.length)
  const segments = relativePath.split('/')
  for (const segment of segments) {
    const invalidCodePoint = [...segment].some((character) => {
      const code = character.codePointAt(0)!
      return code < 32 || code === 127 || (code >= 0xd800 && code <= 0xdfff)
    })
    if (!segment || segment === '.' || invalidCodePoint || /[<>:"|?*\\]/.test(segment)
      || /[. ]$/.test(segment) || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(segment)) {
      throw new PublicAssetValidationError(path, 'Asset filenames must be portable, non-empty path segments.')
    }
    // HTML is published through pages. Reserving its artefact suffix also
    // prevents collisions with present and future page/content-row artefacts.
    if (/\.html$/i.test(segment)) {
      throw new PublicAssetValidationError(path, 'The .html suffix is reserved for published page artefacts.')
    }
  }
  if (isReservedPublicPath(relativePath)) {
    throw new PublicAssetValidationError(path, 'The asset path is inside a server-owned URL namespace.')
  }
  return `/${segments.map(encodeURIComponent).join('/')}`
}

/** Normalise a request URL without accepting encoded separators or dot segments. */
export function publicAssetRequestPath(pathname: string): string | null {
  if (!pathname.startsWith('/')) return null
  try {
    const decoded = pathname.slice(1).split('/').map((segment) => decodeURIComponent(segment))
    if (decoded.some((segment) => segment.includes('/') || segment === '..')) return null
    return publicAssetUrl(`public/${decoded.join('/')}`)
  } catch (error) {
    if (error instanceof URIError || error instanceof PublicAssetValidationError) return null
    throw error
  }
}

/** Canonical base64 and a single safe MIME value, at every binary write boundary. */
export function parseSiteFileBlob(raw: unknown, path: string): SiteFileBlob {
  if (!Value.Check(SiteFileBlobSchema, raw)) {
    throw new PublicAssetValidationError(path, 'An asset blob requires string mimeType and base64 fields.')
  }
  const mimeType = raw.mimeType.trim().replace(/^[^;]+/, (value) => value.toLowerCase())
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:;[ \t]*[a-z0-9!#$&^_.+-]+=(?:[a-z0-9!#$&^_.+-]+|"[a-z0-9 ._+-]*"))*$/i.test(mimeType)) {
    throw new PublicAssetValidationError(path, 'The asset MIME type is invalid.')
  }
  const baseMime = mimeType.split(';', 1)[0]
  if (['text/html', 'application/xhtml+xml', 'text/css'].includes(baseMime)
    || /(?:javascript|ecmascript)/.test(baseMime)) {
    throw new PublicAssetValidationError(path, 'Executable HTML, scripts and styles use their native page/script/style pipeline.')
  }
  const base64 = raw.base64
  const size = base64.length / 4 * 3 - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0)
  const limit = checkSizeLimit(size)
  if (!limit.ok) throw new PublicAssetValidationError(path, limit.message ?? 'Asset payload is too large.')
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?$/.test(base64)) {
    throw new PublicAssetValidationError(path, 'The asset payload must be canonical base64.')
  }
  return { mimeType, base64 }
}

/** Empty placeholders remain editable, but cannot be published. */
export function assertPublicAssetFile(file: SiteFile): void {
  if (file.type !== 'asset') return
  publicAssetUrl(file.path)
  if (!file.blob) throw new PublicAssetValidationError(file.path, 'The asset has no binary payload.')
  parseSiteFileBlob(file.blob, file.path)
}
