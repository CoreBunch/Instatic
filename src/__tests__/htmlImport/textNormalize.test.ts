/**
 * textNormalize.test.ts — imported text/label props collapse the source HTML's
 * pretty-print whitespace (leading indentation, newlines) the way a browser
 * would, so editor text fields don't show stray leading spaces / line breaks.
 */

import { describe, it, expect } from 'bun:test'
import '@modules/base'
import type { PageNode } from '@core/page-tree'
import { importHtml } from '@core/htmlImport'
import { normalizeImportedText } from '@core/htmlImport'

function normalizeFragment(fragment: ReturnType<typeof importHtml>): void {
  for (const id of Object.keys(fragment.nodes)) {
    const node = fragment.nodes[id]
    if (node?.moduleOverlay) {
      fragment.nodes[id] = {
        ...node,
        moduleId: node.moduleOverlay.moduleId,
        props: { ...node.props, ...node.moduleOverlay.props },
      } as PageNode
    }
  }
}

function singleProps(html: string): Record<string, unknown> {
  const r = importHtml(html)
  normalizeFragment(r)
  return r.nodes[r.rootIds[0]!]!.props
}

describe('normalizeImportedText', () => {
  it('collapses whitespace runs and trims', () => {
    expect(normalizeImportedText('\n      instatic  ')).toBe('instatic')
    expect(normalizeImportedText('The Club\n  is how\tit stays')).toBe('The Club is how it stays')
    expect(normalizeImportedText('   ')).toBe('')
  })
})

describe('imported text props are normalized', () => {
  it('paragraph text drops leading indentation + newlines', () => {
    const props = singleProps('<p>\n      The CMS is open source\n      and free.\n    </p>')
    expect(props.text).toBe('The CMS is open source and free.')
  })

  it('button label is trimmed', () => {
    const props = singleProps('<button>\n   Get Instatic   \n</button>')
    expect(props.label).toBe('Get Instatic')
  })

  it('text-only link text is trimmed', () => {
    const props = singleProps('<a href="/x">\n   Visit us \n</a>')
    expect(props.text).toBe('Visit us')
  })
})
