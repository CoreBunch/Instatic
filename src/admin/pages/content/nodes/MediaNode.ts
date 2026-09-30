/**
 * Tiptap node for the content editor's `media` block — an image or video
 * embed that serialises to `![alt](src)` / `@[video](src)` in markdown.
 *
 * Atomic block node. Editing the `src` / `alt` attrs happens via the
 * media-picker modal (the editor only owns selection + delete); the
 * rendered DOM is a non-editable `<figure>` with the asset inside.
 */

import { Node, mergeAttributes } from '@tiptap/core'
import { normalizeMediaImageSize, mediaImageWidth, type MediaImageSize } from '@core/markdown/mediaImagePresentation'

export type ContentMediaType = 'image' | 'video'
export type ContentMediaSize = MediaImageSize

export interface MediaAttributes {
  mediaType: ContentMediaType
  src: string
  alt: string
  /** Image presentation size. Videos keep the default full width. */
  size?: ContentMediaSize
  /** Open image in the publisher's modal lightbox when clicked. */
  lightbox?: boolean
  /** Optional normal HTML title, separate from the editor metadata. */
  title?: string
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    media: {
      /**
       * Insert a media block at the current selection.
       */
      insertMedia: (attributes: MediaAttributes) => ReturnType
      /**
       * Update the currently selected media node's attributes.
       */
      updateMediaAttributes: (attributes: Partial<MediaAttributes>) => ReturnType
    }
  }
}

export const MediaNode = Node.create({
  name: 'media',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      mediaType: {
        default: 'image' as ContentMediaType,
        parseHTML: (element: HTMLElement) =>
          (element.getAttribute('data-media-type') as ContentMediaType | null) ?? 'image',
        renderHTML: (attrs: Record<string, unknown>) => ({ 'data-media-type': String(attrs.mediaType) }),
      },
      src: {
        default: '',
        parseHTML: (element: HTMLElement) => element.getAttribute('data-src') ?? '',
        renderHTML: (attrs: Record<string, unknown>) => ({ 'data-src': String(attrs.src) }),
      },
      alt: {
        default: '',
        parseHTML: (element: HTMLElement) => element.getAttribute('data-alt') ?? '',
        renderHTML: (attrs: Record<string, unknown>) => ({ 'data-alt': String(attrs.alt) }),
      },
      size: {
        default: 'l' as ContentMediaSize,
        parseHTML: (element: HTMLElement) =>
          normalizeMediaImageSize(element.getAttribute('data-size')),
        renderHTML: (attrs: Record<string, unknown>) => ({
          'data-size': normalizeMediaImageSize(attrs.size),
        }),
      },
      lightbox: {
        default: false,
        parseHTML: (element: HTMLElement) => element.getAttribute('data-lightbox') === 'true',
        renderHTML: (attrs: Record<string, unknown>) =>
          attrs.lightbox === true ? { 'data-lightbox': 'true' } : {},
      },
      title: {
        default: '',
        parseHTML: (element: HTMLElement) => element.getAttribute('data-title') ?? '',
        renderHTML: (attrs: Record<string, unknown>) =>
          attrs.title ? { 'data-title': String(attrs.title) } : {},
      },
    }
  },

  parseHTML() {
    return [{ tag: 'figure[data-instatic-media]' }]
  },

  renderHTML({ HTMLAttributes, node }) {
    const attrs = node.attrs as MediaAttributes
    const inner = attrs.mediaType === 'video'
      ? ['video', { controls: '', src: attrs.src }]
      : ['img', {
          src: attrs.src,
          alt: attrs.alt,
          style: `width:${attrs.size === 'original' ? 'auto' : '100%'};max-width:100%;height:auto`,
          ...(attrs.title ? { title: attrs.title } : {}),
        }]
    return [
      'figure',
      mergeAttributes(HTMLAttributes, {
        'data-instatic-media': '',
        'data-size': normalizeMediaImageSize(attrs.size),
        ...(attrs.mediaType === 'image' ? {
          style: `width:${attrs.size === 'original' ? 'fit-content' : mediaImageWidth(normalizeMediaImageSize(attrs.size))};max-width:100%;margin-inline:auto`,
        } : {}),
        ...(attrs.lightbox ? { 'data-lightbox': 'true' } : {}),
      }),
      inner,
    ]
  },

  addCommands() {
    return {
      insertMedia: (attributes) => ({ commands }) => {
        return commands.insertContent({ type: this.name, attrs: attributes })
      },
      updateMediaAttributes: (attributes) => ({ commands }) => {
        return commands.updateAttributes(this.name, attributes)
      },
    }
  },
})
