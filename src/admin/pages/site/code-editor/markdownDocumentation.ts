const INLINE_MARKDOWN = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)]\(([^)\s]+)\)/g

function safeExternalUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
  } catch {
    return null
  }
}

function appendInlineMarkdown(parent: HTMLElement, source: string): void {
  let cursor = 0
  for (const match of source.matchAll(INLINE_MARKDOWN)) {
    const index = match.index ?? 0
    if (index > cursor) parent.append(document.createTextNode(source.slice(cursor, index)))

    const [, strongText, codeText, linkText, rawUrl] = match
    if (strongText !== undefined) {
      const strong = document.createElement('strong')
      appendInlineMarkdown(strong, strongText)
      parent.append(strong)
    } else if (codeText !== undefined) {
      const code = document.createElement('code')
      code.textContent = codeText
      parent.append(code)
    } else if (linkText !== undefined && rawUrl !== undefined) {
      const href = safeExternalUrl(rawUrl)
      if (href) {
        const link = document.createElement('a')
        link.href = href
        link.target = '_blank'
        link.rel = 'noreferrer noopener'
        appendInlineMarkdown(link, linkText)
        parent.append(link)
      } else {
        appendInlineMarkdown(parent, linkText)
      }
    }
    cursor = index + match[0].length
  }

  if (cursor < source.length) parent.append(document.createTextNode(source.slice(cursor)))
}

/** Render the small Markdown subset emitted by TypeScript's standard-library docs. */
export function renderMarkdownDocumentation(container: HTMLElement, markdown: string): void {
  for (const paragraphSource of markdown.trim().split(/\n{2,}/)) {
    if (!paragraphSource) continue
    const paragraph = document.createElement('p')
    const lines = paragraphSource.split('\n')
    lines.forEach((line, index) => {
      if (index > 0) paragraph.append(document.createElement('br'))
      appendInlineMarkdown(paragraph, line)
    })
    container.append(paragraph)
  }
}
