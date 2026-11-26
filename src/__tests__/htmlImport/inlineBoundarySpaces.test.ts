/**
 * inlineBoundarySpaces.test.ts — a space at the edge of an inline element
 * survives the import, so words on either side of the boundary stay apart
 * (`<strong>Focus: </strong>Text` must not read "Focus:Text").
 */

import { describe, it, expect } from 'bun:test'
import '@modules/base'
import { importHtml } from '@core/htmlImport'

type Imported = ReturnType<typeof importHtml>

/** The text a reader sees: every text-bearing prop in document order. */
function textOf(result: Imported, id: string): string {
  const node = result.nodes[id]!
  const own = typeof node.props.text === 'string' ? node.props.text : ''
  return own + node.children.map((childId) => textOf(result, childId)).join('')
}

function readText(html: string): string {
  const result = importHtml(html)
  return result.rootIds.map((id) => textOf(result, id)).join('')
}

function childTexts(html: string): string[] {
  const result = importHtml(html)
  const root = result.nodes[result.rootIds[0]!]!
  return root.children.map((id) => String(result.nodes[id]!.props.text))
}

describe('spaces at inline element boundaries survive the import', () => {
  it('keeps the trailing space of a <strong> before the next word', () => {
    expect(readText('<p><strong>Focus: </strong>Controlling pain and swelling.</p>')).toBe(
      'Focus: Controlling pain and swelling.',
    )
    // The editor field of the <strong> stays trimmed; the space moves to the text after it.
    expect(childTexts('<p><strong>Focus: </strong>Controlling pain.</p>')).toEqual(['Focus:', ' Controlling pain.'])
  })

  it('keeps the trailing space of an <em> in the middle of a sentence', () => {
    expect(readText('<p>Read the <em>important </em>safety information.</p>')).toBe(
      'Read the important safety information.',
    )
  })

  it('keeps the spaces around a link', () => {
    expect(readText('<p>Ask your <a href="/faq">surgeon</a> about recovery.</p>')).toBe(
      'Ask your surgeon about recovery.',
    )
  })

  it('keeps the leading space of an inline element after a word', () => {
    expect(childTexts('<p>Hello<strong> world</strong></p>')).toEqual(['Hello ', 'world'])
  })

  it('separates two adjacent inline elements with one space', () => {
    expect(childTexts('<p><strong>One </strong><em> two</em></p>')).toEqual(['One', ' ', 'two'])
  })

  it('does not double a space that the next text already has', () => {
    expect(childTexts('<p><strong>Focus: </strong> Text</p>')).toEqual(['Focus:', ' Text'])
  })

  it('adds nothing at the edges of the block', () => {
    expect(childTexts('<p><strong> Only </strong></p>')).toEqual(['Only'])
  })

  it('leaves block elements alone', () => {
    expect(childTexts('<div><p>One </p><p>Two</p></div>')).toEqual(['One', 'Two'])
  })
})
