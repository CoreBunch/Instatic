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
import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'
import { Type } from '@core/utils/typeboxHelpers'
import type { Static } from '@core/utils/typeboxHelpers'
import type { AiTool, ToolContext } from '../../runtime/types'
import {
  IMAGE_MIMES,
  MAX_MEDIA_BYTES,
  acceptUploadedMedia,
} from '../../../handlers/cms/mediaUpload'
import { updateMediaAssetMetadata } from '../../../repositories/media'
import { isBlockedAddress } from '../../../plugins/host/network'

const MAX_IMAGE_REDIRECTS = 5
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const FETCH_TIMEOUT_MS = 15_000

const UploadMediaInput = Type.Object(
  {
    filename: Type.String({
      minLength: 1,
      description:
        'Display filename for the asset (e.g. "winner-1.webp"). The server picks the on-disk extension from the sniffed file type; the client extension is ignored.',
    }),
    data: Type.Optional(
      Type.String({
        description:
          'Base64-encoded image bytes (a bare `data:` URI prefix is also accepted). Provide EITHER `data` OR `sourceUrl`, not both.',
      }),
    ),
    sourceUrl: Type.Optional(
      Type.String({
        description:
          'https URL the server downloads the image from (SSRF-guarded: private/loopback/link-local hosts are refused). Provide EITHER `data` OR `sourceUrl`, not both.',
      }),
    ),
    altText: Type.Optional(
      Type.String({
        description: 'Accessible alt text stored on the media asset.',
      }),
    ),
  },
  { additionalProperties: false },
)

type UploadMediaArgs = Static<typeof UploadMediaInput>

/** Strip an IPv6 URL bracket wrapper so `isIP`/`isBlockedAddress` see the raw address. */
function unbracketHost(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}

/**
 * Validate one outbound target: https only, host resolves, and NO resolved
 * address is in a blocked range. Re-run for every redirect hop so an
 * allowed-looking host can never bounce the download to an internal target.
 *
 * Residual note: like the plugin path, we validate resolved addresses then
 * `fetch` by hostname (which re-resolves) — the same DNS-rebinding window the
 * rest of the host tolerates. Redirects are followed manually so each new
 * location is re-validated here before any request is made to it.
 */
async function assertPublicHttpsTarget(urlString: string): Promise<URL> {
  let parsed: URL
  try {
    parsed = new URL(urlString)
  } catch {
    throw new Error(`Invalid sourceUrl: "${urlString}"`)
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`sourceUrl must be an https URL (got "${parsed.protocol}").`)
  }
  const host = unbracketHost(parsed.hostname)
  const addresses = isIP(host)
    ? [host]
    : (await lookup(host, { all: true })).map((r) => r.address)
  if (addresses.length === 0) {
    throw new Error(`sourceUrl host "${host}" did not resolve to any address.`)
  }
  for (const address of addresses) {
    if (isBlockedAddress(address)) {
      throw new Error(
        `sourceUrl host "${host}" resolves to a blocked address (${address}).`,
      )
    }
  }
  return parsed
}

/** Read a response stream into a buffer, aborting if it exceeds `maxBytes`. */
async function readBounded(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.length
    if (total > maxBytes) {
      await reader.cancel()
      throw new Error(`Image exceeds the ${Math.floor(maxBytes / (1024 * 1024))} MB limit.`)
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

async function downloadRemoteImage(sourceUrl: string): Promise<Uint8Array> {
  let current = sourceUrl
  for (let hop = 0; ; hop++) {
    const target = await assertPublicHttpsTarget(current)
    const response = await fetch(target, {
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    const location = response.headers.get('location')
    if (REDIRECT_STATUSES.has(response.status) && location) {
      if (hop >= MAX_IMAGE_REDIRECTS) {
        throw new Error(`sourceUrl exceeded ${MAX_IMAGE_REDIRECTS} redirects.`)
      }
      current = new URL(location, current).toString()
      continue
    }
    if (!response.ok || !response.body) {
      throw new Error(`sourceUrl download failed (HTTP ${response.status}).`)
    }
    return readBounded(response.body, MAX_MEDIA_BYTES)
  }
}

/** Decode inline image bytes, tolerating a leading `data:<mime>;base64,` prefix. */
function decodeInlineImage(data: string): Uint8Array {
  const comma = data.startsWith('data:') ? data.indexOf(',') : -1
  const base64 = comma >= 0 ? data.slice(comma + 1) : data
  return new Uint8Array(Buffer.from(base64, 'base64'))
}

export const uploadMediaMcpTool: AiTool = {
  name: 'content_upload_media',
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

    const bytes = hasData
      ? decodeInlineImage(args.data!)
      : await downloadRemoteImage(args.sourceUrl!)
    if (bytes.length === 0) {
      throw new Error('Decoded image is empty.')
    }

    const file = new File([bytes], args.filename)
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
