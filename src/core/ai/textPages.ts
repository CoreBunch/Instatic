/**
 * Content hashing and pagination shared by every "read this file" agent
 * tool (site code assets, plugin IDE files). One hash function means the
 * `expectedHash` an agent reads back from one tool is the hash another tool
 * checks against; one paginator means every read reports the same
 * `pageInfo` shape.
 */

const encoder = new TextEncoder()

/** SHA-256 of the UTF-8 encoding, lowercase hex. */
export async function hashText(content: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(content))
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

export function utf8ByteLength(content: string): number {
  return encoder.encode(content).byteLength
}

export interface TextPageInfo {
  part: number
  totalParts: number
  nextPart: number | null
  maxChars: number
  start: number
  end: number
  totalChars: number
}

export type TextPage =
  | { ok: true; content: string; pageInfo: TextPageInfo }
  | { ok: false; error: string }

/**
 * Slice `content` into `maxChars` pages and return page `part` (1-based).
 * A file shorter than one page is a single part; an out-of-range part is an
 * error the tool surfaces verbatim.
 */
export function paginateText(
  content: string,
  options: { part?: number; maxChars?: number; defaultMaxChars: number },
): TextPage {
  const maxChars = options.maxChars ?? options.defaultMaxChars
  const totalParts = Math.max(1, Math.ceil(content.length / maxChars))
  const part = options.part ?? 1
  if (part > totalParts) {
    return { ok: false, error: `Part ${part} is out of range; totalParts is ${totalParts}.` }
  }
  const start = (part - 1) * maxChars
  const end = Math.min(content.length, start + maxChars)
  return {
    ok: true,
    content: content.slice(start, end),
    pageInfo: {
      part,
      totalParts,
      nextPart: part < totalParts ? part + 1 : null,
      maxChars,
      start,
      end,
      totalChars: content.length,
    },
  }
}
