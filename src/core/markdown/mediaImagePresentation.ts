import type { JSONNode } from './markdownDocument'

export type MediaImageSize = 'original' | 'l' | 'm' | 's'

export function normalizeMediaImageSize(value: unknown): MediaImageSize {
  if (value === 'sm') return 'm'
  return value === 'original' || value === 'm' || value === 's' ? value : 'l'
}

export function mediaImageWidth(size: MediaImageSize): string {
  return { original: 'auto', l: '100%', m: 'min(100%, 560px)', s: 'min(100%, 320px)' }[size]
}

export interface MediaImagePresentation {
  size: MediaImageSize
  lightbox: boolean
  title: string
}


export function mediaNode(
  mediaType: 'image' | 'video',
  src: string,
  alt: string,
  presentation: Partial<MediaImagePresentation> = {},
): JSONNode {
  return {
    type: 'media',
    attrs: {
      mediaType,
      src,
      alt,
      size: presentation.size ?? 'l',
      lightbox: presentation.lightbox ?? false,
      title: presentation.title ?? '',
    },
  }
}

/**
 * Read the small, editor-owned metadata vocabulary from a Markdown image
 * title. Other title text remains a normal HTML title so existing Markdown
 * stays backwards compatible.
 */
export function parseMediaImageTitle(rawTitle: string | null | undefined): MediaImagePresentation {
  const tokens = (rawTitle ?? '').trim().split(/\s+/).filter(Boolean)
  let size: MediaImageSize = 'l'
  let lightbox = false
  const titleTokens: string[] = []

  for (const token of tokens) {
    const normalized = token.toLowerCase()
    if (/^size=(original|sm|m|s)$/.test(normalized)) {
      size = normalizeMediaImageSize(normalized.slice(5))
    } else if (normalized === 'size=l' || normalized === 'size=large') {
      size = 'l'
    } else if (normalized === 'lightbox') {
      lightbox = true
    } else if (normalized === 'lightbox=false') {
      lightbox = false
    } else {
      titleTokens.push(token)
    }
  }

  return { size, lightbox, title: titleTokens.join(' ') }
}

export function serializeMediaImageTitle(presentation: MediaImagePresentation): string {
  const tokens: string[] = []
  if (presentation.size !== 'l') tokens.push(`size=${presentation.size}`)
  if (presentation.lightbox) tokens.push('lightbox')
  if (presentation.title) tokens.push(presentation.title)
  return tokens.join(' ')
}

export function escapeImageTitle(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}


export function mediaSizeAttr(node: JSONNode, key: string): MediaImageSize {
  return normalizeMediaImageSize(node.attrs?.[key])
}

export function booleanAttr(node: JSONNode, key: string): boolean {
  return node.attrs?.[key] === true
}
