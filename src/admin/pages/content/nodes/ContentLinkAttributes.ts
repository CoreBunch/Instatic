import { Extension } from '@tiptap/core'

export const ContentLinkAttributes = Extension.create({
  name: 'contentLinkAttributes',
  addGlobalAttributes() {
    return [{
      types: ['link'],
      attributes: {
        download: {
          default: null,
          parseHTML: (element) => element.hasAttribute('download') ? '' : null,
          renderHTML: (attributes) => attributes.download != null ? { download: '' } : {},
        },
      },
    }]
  },
})
