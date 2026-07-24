/**
 * Canvas-side agreement tests: the `*Editor.tsx` preview components render the
 * element/attributes dictated by the SAME shared leaves the publisher uses, so
 * the canvas cannot lie about what visitors will see.
 *
 * Covers link, button, and list — the modules whose editor previews render
 * pure DOM from props. (base.video's editor resolves media through admin React
 * hooks; its shared brain — `youtubeEmbedUrl` — is locked in the sibling
 * `base-modules-shared-render.test.ts`.)
 */
import { describe, it, expect } from 'bun:test'
import React from 'react'
import { render as renderReact } from '@testing-library/react'

import { LinkModule } from '@modules/base/link'
import { ButtonModule } from '@modules/base/button'
import { ListModule } from '@modules/base/list'
import { ContainerModule } from '@modules/base/container'
import { SvgModule } from '@modules/base/svg'
import { anchorRel } from '@modules/base/shared/anchorTarget'
import { parseItems } from '@modules/base/list/items'

function renderEditor(
  def: { component: React.ComponentType<never>; defaults: Record<string, unknown> },
  props: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  const Component = def.component
  return renderReact(
    React.createElement(Component, {
      props: { ...def.defaults, ...props },
      nodeId: 'test-node',
      isSelected: false,
      ...extra,
    } as never),
  )
}

describe('LinkEditor canvas DOM matches the shared helpers', () => {
  it('emits rel="noopener noreferrer" for _blank, none otherwise (== anchorRel)', () => {
    const blank = renderEditor(LinkModule, { href: 'https://e.com', target: '_blank' })
    const anchorBlank = blank.container.querySelector('a')
    expect(anchorBlank?.getAttribute('rel')).toBe(anchorRel('_blank'))
    expect(anchorBlank?.getAttribute('target')).toBe('_blank')

    const self = renderEditor(LinkModule, { href: 'https://e.com', target: '_self' })
    expect(self.container.querySelector('a')?.getAttribute('rel')).toBe(null)
  })

  it('renders children when present, falls back to text when empty (== linkUsesChildren)', () => {
    const withChildren = renderEditor(
      LinkModule,
      { text: 'fallback' },
      { children: React.createElement('strong', null, 'kid') },
    )
    expect(withChildren.container.querySelector('a strong')?.textContent).toBe('kid')
    expect(withChildren.container.textContent).not.toContain('fallback')

    const withoutChildren = renderEditor(LinkModule, { text: 'fallback' })
    expect(withoutChildren.container.querySelector('a')?.textContent).toBe('fallback')
  })
})

describe('ButtonEditor canvas DOM matches resolveButtonAnchor', () => {
  it('renders <a> for a real href and <button> for "#"/empty — same as the publisher', () => {
    expect(renderEditor(ButtonModule, { href: 'https://e.com', label: 'Go' }).container.querySelector('a')?.getAttribute('href')).toBe('https://e.com')
    // "#" collapses to a <button> on BOTH paths now — the old editor showed an
    // <a href="#"> the publisher would never emit.
    expect(renderEditor(ButtonModule, { href: '#', label: 'Go' }).container.querySelector('a')).toBeNull()
    expect(renderEditor(ButtonModule, { href: '#', label: 'Go' }).container.querySelector('button')).not.toBeNull()
    expect(renderEditor(ButtonModule, { href: '', label: 'Go' }).container.querySelector('button')).not.toBeNull()
  })

  it('emits rel for a _blank anchor (== anchorRel)', () => {
    const blank = renderEditor(ButtonModule, { href: 'https://e.com', target: '_blank', label: 'Go' })
    expect(blank.container.querySelector('a')?.getAttribute('rel')).toBe(anchorRel('_blank'))
  })
})

describe('ListEditor canvas DOM matches parseItems', () => {
  it('renders one <li> per parsed item, in order', () => {
    const items = 'Alpha\n\n  Beta  \nGamma'
    const { container } = renderEditor(ListModule, { items })
    const lis = Array.from(container.querySelectorAll('li')).map((li) => li.textContent)
    expect(lis).toEqual(parseItems(items))
  })

  it('renders <ol> for ordered, <ul> for unordered (== publisher tag)', () => {
    expect(renderEditor(ListModule, { listType: 'ordered', items: 'A' }).container.querySelector('ol')).not.toBeNull()
    expect(renderEditor(ListModule, { listType: 'unordered', items: 'A' }).container.querySelector('ul')).not.toBeNull()
  })
})

describe('ContainerEditor empty-state placeholder', () => {
  it('suppresses the empty-container affordance when inline styles make the element authored', () => {
    const { container, queryByText } = renderEditor(
      ContainerModule,
      {},
      { nodeWrapperProps: { style: { minHeight: 120 } } },
    )

    const root = container.querySelector('div')
    expect(root?.getAttribute('style')).toContain('min-height: 120px')
    expect(root?.getAttribute('data-canvas-empty-container')).toBeNull()
    expect(queryByText('Empty container')).toBeNull()
  })
})

describe('SvgEditor canvas root', () => {
  it('uses the authored svg as the canvas root instead of adding a sizing wrapper', () => {
    const { container } = renderEditor(
      SvgModule,
      { svg: '<svg viewBox="0 0 24 24"><path d="M2 2h20v20H2z"/></svg>' },
      {
        mcClassName: 'seal-mark',
        nodeWrapperProps: {
          'data-node-id': 'svg-node',
          style: { width: '50%', height: '50%' },
        },
      },
    )

    const root = container.firstElementChild
    expect(root?.tagName.toLowerCase()).toBe('svg')
    expect(root?.parentElement).toBe(container)
    expect(root?.classList.contains('seal-mark')).toBe(true)
    expect(root?.getAttribute('data-node-id')).toBe('svg-node')
    expect(root?.getAttribute('style')).toContain('width: 50%')
    expect(root?.getAttribute('style')).toContain('height: 50%')
    expect(root?.querySelector('path')).not.toBeNull()
  })

  it('preserves authored root attributes while node classes and styles win in publisher order', () => {
    const { container } = renderEditor(
      SvgModule,
      {
        svg: [
          '<svg class="source-mark" viewBox="0 0 24 24"',
          ' style="width: 12px; height: 13px; color: red">',
          '<circle cx="12" cy="12" r="10" fill="currentColor"/>',
          '</svg>',
        ].join(''),
      },
      {
        mcClassName: 'seal-mark',
        nodeWrapperProps: {
          style: { width: '50%', height: '50%' },
        },
      },
    )

    const root = container.querySelector('svg')
    expect(root?.getAttribute('viewBox')).toBe('0 0 24 24')
    expect(root?.getAttribute('class')?.split(' ')).toEqual(['seal-mark', 'source-mark'])
    expect(root?.getAttribute('style')).toContain('width: 50%')
    expect(root?.getAttribute('style')).toContain('height: 50%')
    expect(root?.getAttribute('style')).toContain('color: red')
  })
})
