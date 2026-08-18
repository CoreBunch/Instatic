/**
 * Media upload tool for MCP connectors.
 *
 * The rest of the MCP surface can *list* and *assign* existing media but never
 * create it — an external agent building a page had no way to get an image into
 * the library. This server-side tool closes that gap: it accepts image bytes
 * either inline (base64) or by an https `sourceUrl` the host downloads, then
 * runs them through the exact same `acceptUploadedMedia` core the HTTP media
 * route uses (magic-byte MIME sniffing, SVG sanitisation, storage dispatch,
 * responsive variants). No new byte-handling path is introduced.
 *
 * The `sourceUrl` branch is the sharp edge: letting the server fetch an
 * arbitrary URL is a classic SSRF vector (`http://169.254.169.254/…` cloud
 * metadata, `localhost` admin ports). It is gated exactly like the plugin
 * network layer — https-only, DNS-resolved, every resolved address checked
 * against the shared `isBlockedAddress` blocklist, redirects followed manually
 * and re-validated per hop, and the download size-capped while streaming.
 */
import { Type } from '@core/utils/typeboxHelpers'
import type { Static } from '@core/utils/typeboxHelpers'
import type { AiTool, ToolContext } from '../../runtime/types'
import {
  IMAGE_MIMES,
  MAX_MEDIA_BYTES,
  acceptUploadedMedia,
} from '../../../handlers/cms/mediaUpload'
import { updateMediaAssetMetadata } from '../../../repositories/media'
import { downloadRemoteImage } from '../../../handlers/cms/remoteImageFetch'

const MAX_FILENAME_CHARS = 255
const MAX_SOURCE_URL_CHARS = 2_048
const MAX_ALT_TEXT_CHARS = 4_096
const MAX_DATA_URI_PREFIX_CHARS = 256
const MAX_BASE64_CHARS = 4 * Math.ceil(MAX_MEDIA_BYTES / 3)
const MAX_INLINE_IMAGE_DATA_CHARS = MAX_BASE64_CHARS + MAX_DATA_URI_PREFIX_CHARS
const CANONICAL_BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

const UploadMediaInput = Type.Object(
  {
    filename: Type.String({
      minLength: 1,
      maxLength: MAX_FILENAME_CHARS,
      description:
        'Display filename for the asset (e.g. "winner-1.webp"). The server picks the on-disk extension from the sniffed file type; the client extension is ignored.',
    }),
    data: Type.Optional(
      Type.String({
        maxLength: MAX_INLINE_IMAGE_DATA_CHARS,
        description:
          'Base64-encoded image bytes (a bare `data:` URI prefix is also accepted). Provide EITHER `data` OR `sourceUrl`, not both.',
      }),
    ),
    sourceUrl: Type.Optional(
      Type.String({
        maxLength: MAX_SOURCE_URL_CHARS,
        description:
          'https URL the server downloads the image from (SSRF-guarded: private/loopback/link-local hosts are refused). Provide EITHER `data` OR `sourceUrl`, not both.',
      }),
    ),
    altText: Type.Optional(
      Type.String({
        maxLength: MAX_ALT_TEXT_CHARS,
        description: 'Accessible alt text stored on the media asset.',
      }),
    ),
  },
  { additionalProperties: false },
)

type UploadMediaArgs = Static<typeof UploadMediaInput>

function inlineBase64Payload(data: string): string {
  if (!data.startsWith('data:')) return data

  const comma = data.indexOf(',')
  if (comma < 0 || comma + 1 > MAX_DATA_URI_PREFIX_CHARS) {
    throw new Error('Inline image data URI is invalid.')
  }
  const prefix = data.slice(0, comma + 1)
  if (!/^data:[^,]*;base64,$/i.test(prefix)) {
    throw new Error('Inline image data URI must use base64 encoding.')
  }
  return data.slice(comma + 1)
}

/** Decode canonical base64 only, rejecting oversized input before allocating bytes. */
function decodeInlineImage(data: string): Uint8Array<ArrayBuffer> {
  if (data.length > MAX_INLINE_IMAGE_DATA_CHARS) {
    throw new Error('Inline image data exceeds the 50 MB hard limit.')
  }
  const base64 = inlineBase64Payload(data)
  if (base64.length % 4 !== 0 || !CANONICAL_BASE64.test(base64)) {
    throw new Error('Inline image data is not valid base64.')
  }

  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  const decodedBytes = (base64.length / 4) * 3 - padding
  if (decodedBytes > MAX_MEDIA_BYTES) {
    throw new Error('Inline image data exceeds the 50 MB hard limit.')
  }

  const buf = Buffer.from(base64, 'base64')
  const out = new Uint8Array(buf.length)
  out.set(buf)
  return out
}

export const uploadMediaMcpTool: AiTool = {
  name: 'media_upload',
  description:
    'Upload a new image into the Media library and return its id + publicPath so you can reference or assign it. Provide the bytes as base64 in `data`, OR an https `sourceUrl` the server downloads. Accepts JPEG, PNG, GIF, WebP, and SVG (SVG is sanitised); the file type is sniffed from the bytes, not the filename. Requires the connector to have media.write.',
  scope: 'content',
  execution: 'server',
  mutates: true,
  requiredCapabilities: ['media.write'],
  inputSchema: UploadMediaInput,
  handler: async (input, ctx: ToolContext) => {
    const args = input as UploadMediaArgs
    const hasData = typeof args.data === 'string' && args.data.length > 0
    const hasUrl = typeof args.sourceUrl === 'string' && args.sourceUrl.length > 0
    if (hasData === hasUrl) {
      throw new Error('Provide exactly one of `data` (base64) or `sourceUrl`.')
    }

    ctx.signal.throwIfAborted()
    const bytes = hasData
      ? decodeInlineImage(args.data!)
      : await downloadRemoteImage(args.sourceUrl!, MAX_MEDIA_BYTES, ctx.signal)
    if (bytes.length === 0) {
      throw new Error('Decoded image is empty.')
    }

    const file = new File([bytes], args.filename)
    ctx.signal.throwIfAborted()
    const result = await acceptUploadedMedia(ctx.db, {
      file,
      maxBytes: MAX_MEDIA_BYTES,
      allowedMimes: IMAGE_MIMES,
      role: 'original',
      uploadedByUserId: ctx.userId,
      oversizedMessage: 'Image exceeds the 50 MB hard limit',
      unsupportedMessage:
        'Only JPEG, PNG, GIF, WebP, and SVG images can be uploaded through this tool',
    })
    // `acceptUploadedMedia` returns a ready-to-send error Response on any policy
    // failure. MCP has no HTTP surface, so surface the envelope message as a
    // thrown tool error instead.
    if (result instanceof Response) {
      const message = await result
        .json()
        .then((body: { error?: string }) => body.error)
        .catch(() => null)
      throw new Error(message ?? `Upload rejected (HTTP ${result.status}).`)
    }

    let asset = result
    if (args.altText !== undefined) {
      const updated = await updateMediaAssetMetadata(ctx.db, asset.id, {
        altText: args.altText,
      })
      if (updated) asset = updated
    }

    return {
      id: asset.id,
      filename: asset.filename,
      publicPath: asset.publicPath,
      mimeType: asset.mimeType,
      altText: asset.altText,
      width: asset.width,
      height: asset.height,
    }
  },
}
