/**
 * Shared render-brain agreement tests for the base modules that emit HTML on
 * BOTH the publisher path (`index.ts` `render()`) and the canvas path
 * (`*Editor.tsx`).
 *
 * These guard the most embarrassing bug class this product can ship: the
 * editor showing markup that differs from what visitors get. Each base module
 * used to carry two independent copies of its markup logic; the divergence was
 * killed by extracting the pure decisions into sibling `.ts` leaves that BOTH
 * paths import. This suite asserts:
 *
 *   1. The shared helpers (`anchorRel`, `parseItems`, `linkUsesChildren`,
 *      `resolveButtonAnchor`, `youtubeEmbedUrl`) behave as the contract
 *      requires.
 *   2. The publisher `render()` output is byte-identical to the captured
 *      golden — the refactor changed no published bytes.
 *
 * Editor-component agreement (canvas DOM matches the same helpers) lives in
 * `base-modules-shared-render.editor.test.tsx`.
 */
import { describe, it, expect } from 'bun:test'

import { LinkModule } from '@modules/base/link'
import { ButtonModule } from '@modules/base/button'
import { ListModule } from '@modules/base/list'
import { VideoModule } from '@modules/base/video'

import { anchorRel, mergeAnchorRel, ANCHOR_TARGET_OPTIONS } from '@modules/base/shared/anchorTarget'
import { linkUsesChildren } from '@modules/base/link/content'
import { resolveButtonAnchor } from '@modules/base/button/anchor'
import { parseItems } from '@modules/base/list/items'
import { youtubeEmbedUrl, parseYoutubeId } from '@modules/base/video/youtube'

// ---------------------------------------------------------------------------
// Shared helper contracts
// ---------------------------------------------------------------------------

describe('anchorRel — single source for the noopener rule', () => {
  it('hardens new-tab links and only new-tab links', () => {
    expect(anchorRel('_blank')).toBe('noopener noreferrer')
    expect(anchorRel('_self')).toBeNull()
    expect(anchorRel('_parent')).toBeNull()
  })

  it('drives BOTH link and button render() — _blank emits rel, others omit it', () => {
    const linkBlank = LinkModule.render({ ...LinkModule.defaults, href: 'https://e.com', target: '_blank' }, []).html
    const linkSelf = LinkModule.render({ ...LinkModule.defaults, href: 'https://e.com', target: '_self' }, []).html
    expect(linkBlank).toContain('rel="noopener noreferrer"')
    expect(linkSelf).not.toContain('rel=')

    const btnBlank = ButtonModule.render({ ...ButtonModule.defaults, href: 'https://e.com', target: '_blank' }, []).html
    const btnSelf = ButtonModule.render({ ...ButtonModule.defaults, href: 'https://e.com', target: '_self' }, []).html
    expect(btnBlank).toContain('rel="noopener noreferrer"')
    expect(btnSelf).not.toContain('rel=')
  })

  it('link and button expose the SAME target options from the shared leaf', () => {
    const values = ANCHOR_TARGET_OPTIONS.map((o) => o.value)
    expect(values).toEqual(['_self', '_blank', '_parent'])
    expect(LinkModule.schema.target).toMatchObject({ type: 'select', options: ANCHOR_TARGET_OPTIONS as never })
    expect(ButtonModule.schema.target).toMatchObject({ type: 'select', options: ANCHOR_TARGET_OPTIONS as never })
  })
})

describe('mergeAnchorRel — one rel attribute, authored tokens plus the security rel', () => {
  it('keeps authored tokens, always adds the _blank guard, and emits each token once', () => {
    expect(mergeAnchorRel(undefined, '_self')).toBeNull()
    expect(mergeAnchorRel('', '_self')).toBeNull()
    expect(mergeAnchorRel('nofollow', '_self')).toBe('nofollow')
    expect(mergeAnchorRel(' next  prev ', '_parent')).toBe('next prev')
    expect(mergeAnchorRel(undefined, '_blank')).toBe(anchorRel('_blank'))
    expect(mergeAnchorRel('nofollow', '_blank')).toBe('nofollow noopener noreferrer')
    expect(mergeAnchorRel('noopener', '_blank')).toBe('noopener noreferrer')
    expect(mergeAnchorRel('noreferrer sponsored', '_blank')).toBe('noreferrer sponsored noopener')
    expect(mergeAnchorRel(42, '_blank')).toBe('noopener noreferrer')
  })

  const relAttributes = (html: string): string[] => [...html.matchAll(/\brel="([^"]*)"/g)].map((m) => m[1]!)

  it('link and button render() emit exactly one rel, keeping the authored tokens', () => {
    const cases = [
      LinkModule.render({ ...LinkModule.defaults, href: '/page/2/', target: '_self', htmlAttributes: { rel: 'next' } }, []).html,
      ButtonModule.render({ ...ButtonModule.defaults, href: '/page/2/', target: '_self', htmlAttributes: { rel: 'next' } }, []).html,
    ]
    for (const html of cases) expect(relAttributes(html)).toEqual(['next'])
  })

  it('an authored rel never removes the noopener guard on a new-tab link or button', () => {
    // Two rel attributes on one element is a parse error: the browser keeps
    // the first. Before the merge the author's rel was emitted before the
    // module's, so a nofollow new-tab link published without noopener.
    const link = LinkModule.render({ ...LinkModule.defaults, href: 'https://e.com', target: '_blank', htmlAttributes: { rel: 'nofollow' } }, []).html
    const button = ButtonModule.render({ ...ButtonModule.defaults, href: 'https://e.com', target: '_blank', htmlAttributes: { rel: 'nofollow' } }, []).html
    for (const html of [link, button]) {
      expect(relAttributes(html)).toEqual(['nofollow noopener noreferrer'])
    }
    const authoredGuard = LinkModule.render({ ...LinkModule.defaults, href: 'https://e.com', target: '_blank', htmlAttributes: { rel: 'noopener noreferrer' } }, []).html
    expect(relAttributes(authoredGuard)).toEqual(['noopener noreferrer'])
  })

  it('escapes the authored rel and leaves the other bag attributes alone', () => {
    const html = LinkModule.render(
      { ...LinkModule.defaults, href: 'https://e.com', target: '_self', htmlAttributes: { rel: 'a"b', 'data-track': 'x' } },
      [],
    ).html
    expect(html).toContain('rel="a&quot;b"')
    expect(html).toContain('data-track="x"')
  })
})

describe('linkUsesChildren — children-vs-text fallback', () => {
  it('treats an empty children collection as "use text", not "use empty children"', () => {
    expect(linkUsesChildren(0)).toBe(false)
    expect(linkUsesChildren(1)).toBe(true)
    expect(linkUsesChildren(3)).toBe(true)
  })

  it('render() falls back to text exactly when the helper says no children', () => {
    const withChildren = LinkModule.render({ ...LinkModule.defaults, text: 'fallback' }, ['<strong>kid</strong>']).html
    const withoutChildren = LinkModule.render({ ...LinkModule.defaults, text: 'fallback' }, []).html
    expect(withChildren).toContain('<strong>kid</strong>')
    expect(withChildren).not.toContain('fallback')
    expect(withoutChildren).toContain('>fallback<')
  })
})

describe('resolveButtonAnchor — element decision', () => {
  it('returns an anchor only for an href that survives sanitisation as not "#"', () => {
    expect(resolveButtonAnchor('https://e.com')).toEqual({ href: 'https://e.com' })
    expect(resolveButtonAnchor('')).toBeNull()
    expect(resolveButtonAnchor('#')).toBeNull()
    expect(resolveButtonAnchor('javascript:alert(1)')).toBeNull() // safeUrl collapses to "#"
    expect(resolveButtonAnchor(undefined)).toBeNull()
  })

  it('render() emits <a> iff resolveButtonAnchor is truthy', () => {
    expect(ButtonModule.render({ ...ButtonModule.defaults, href: 'https://e.com' }, []).html).toMatch(/^<a /)
    expect(ButtonModule.render({ ...ButtonModule.defaults, href: '' }, []).html).toMatch(/^<button /)
    expect(ButtonModule.render({ ...ButtonModule.defaults, href: '#' }, []).html).toMatch(/^<button /)
  })

  it('htmlTag agrees with render() on the element choice', () => {
    const tagFor = (href: string) =>
      typeof ButtonModule.htmlTag === 'function' ? ButtonModule.htmlTag({ ...ButtonModule.defaults, href }) : ButtonModule.htmlTag
    expect(tagFor('https://e.com')).toBe('a')
    expect(tagFor('#')).toBe('button')
    expect(tagFor('')).toBe('button')
  })
})

describe('parseItems — shared list splitter', () => {
  it('trims, drops blank lines, and matches the render() <li> count', () => {
    expect(parseItems('A\n\n  B  \n')).toEqual(['A', 'B'])
    const { html } = ListModule.render({ ...ListModule.defaults, items: 'A\n\n  B  \n' }, [])
    expect((html.match(/<li>/g) ?? []).length).toBe(parseItems('A\n\n  B  \n').length)
  })
})

describe('youtubeEmbedUrl — shared video URL brain', () => {
  it('render() embeds exactly the URL the shared helper builds', () => {
    const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    const id = parseYoutubeId(url)
    expect(id).toBe('dQw4w9WgXcQ')
    const embed = youtubeEmbedUrl(id as string, false)
    expect(VideoModule.render({ ...VideoModule.defaults, videoUrl: url } as never, []).html).toContain(`src="${embed}"`)
  })
})

// ---------------------------------------------------------------------------
// Golden lock — published bytes must not change as the shared leaves evolve
// ---------------------------------------------------------------------------

describe('published render() golden (byte-identical behavior invariant)', () => {
  const GOLDEN: Record<string, string> = {
    'link.default': '<a href="#" target="_self">Click here</a>',
    'link.blank': '<a href="https://example.com" target="_blank" rel="noopener noreferrer">X</a>',
    'link.parent': '<a href="https://e.com" target="_parent">Click here</a>',
    'link.children': '<a href="#" target="_self"><strong>kid</strong></a>',
    'link.empty-children': '<a href="#" target="_self">fallback</a>',
    'button.default': '<button type="button">Get Started</button>',
    'button.href': '<a href="https://e.com" target="_self">Go</a>',
    'button.href-blank': '<a href="https://e.com" target="_blank" rel="noopener noreferrer">Go</a>',
    'button.hash': '<button type="button">Go</button>',
    'button.disabled': '<button type="button" disabled aria-disabled="true">Go</button>',
    'list.ul': '<ul><li>A</li><li>B</li><li>C</li></ul>',
    'list.ol': '<ol><li>A</li><li>B</li></ol>',
    'list.empty': '<ul></ul>',
  }

  const actual: Record<string, string> = {
    'link.default': LinkModule.render(LinkModule.defaults, []).html,
    'link.blank': LinkModule.render({ ...LinkModule.defaults, href: 'https://example.com', target: '_blank', text: 'X' }, []).html,
    'link.parent': LinkModule.render({ ...LinkModule.defaults, href: 'https://e.com', target: '_parent' }, []).html,
    'link.children': LinkModule.render({ ...LinkModule.defaults, text: 'fallback' }, ['<strong>kid</strong>']).html,
    'link.empty-children': LinkModule.render({ ...LinkModule.defaults, text: 'fallback' }, []).html,
    'button.default': ButtonModule.render(ButtonModule.defaults, []).html,
    'button.href': ButtonModule.render({ ...ButtonModule.defaults, href: 'https://e.com', label: 'Go' }, []).html,
    'button.href-blank': ButtonModule.render({ ...ButtonModule.defaults, href: 'https://e.com', target: '_blank', label: 'Go' }, []).html,
    'button.hash': ButtonModule.render({ ...ButtonModule.defaults, href: '#', label: 'Go' }, []).html,
    'button.disabled': ButtonModule.render({ ...ButtonModule.defaults, disabled: true, label: 'Go' }, []).html,
    'list.ul': ListModule.render({ ...ListModule.defaults, items: 'A\nB\nC' }, []).html,
    'list.ol': ListModule.render({ ...ListModule.defaults, listType: 'ordered', items: 'A\n\n  B  \n' }, []).html,
    'list.empty': ListModule.render({ ...ListModule.defaults, items: '' }, []).html,
  }

  for (const key of Object.keys(GOLDEN)) {
    it(`render() ${key} is unchanged`, () => {
      expect(actual[key]).toBe(GOLDEN[key])
    })
  }
})
