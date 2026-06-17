/**
 * mapping.test.ts — Unit tests for src/core/htmlImport/
 *
 * Tests every rule + behavior described in the 'Test bar' of the spec
 * (docs/plans/2026-05-29-html-pipeline.md).
 *
 * Structure:
 *   - Base module registration side-effect (import '@modules/base')
 *   - Per-rule describe blocks, each with ~5-10 hand-written snippets
 *   - Strip-safety describe block (script/style/inline-handler/inline-style)
 *   - Class preservation describe block
 *   - Nesting / parent-child structure describe block
 *   - Catch-all guarantee describe block
 *
 * No round-trip pipeline, no fixtures — pure per-rule unit assertions.
 */

import { describe, it, expect } from 'bun:test'
// Self-registers all base modules with the global registry singleton.
// walkAndMap calls registry.getOrThrow(moduleId) — without this import it throws.
import '@modules/base'
import type { PageNode } from '@core/page-tree'
import { importHtml, walkAndMap, parseHtml, stripUnsafe } from '@core/htmlImport'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return the single root node from an importHtml result. Throws if not exactly one root. */
function single(html: string): PageNode {
  const result = importHtml(html)
  expect(result.rootIds).toHaveLength(1)
  const id = result.rootIds[0]!
  return result.nodes[id]!
}

/** Return the props of the single root node. */
function singleProps(html: string): Record<string, unknown> {
  return single(html).props
}

/** Convenience: importHtml + return the full result object. */
function imported(html: string) {
  return importHtml(html)
}

describe('body element metadata', () => {
  it('preserves body class, safe HTML attributes, and inline styles outside child rootIds', () => {
    const result = imported(`
      <!doctype html>
      <html>
        <body id="page-root" class="body-bg theme-dark" data-bg-src="./hero.png" style="background-image: url('./hero.png'); color: white">
          <main class="content">Hello</main>
        </body>
      </html>
    `)

    expect(result.rootIds).toHaveLength(1)
    expect(result.nodes[result.rootIds[0]!]!.classIds).toEqual(['content'])
    expect(result.body?.classIds).toEqual(['body-bg', 'theme-dark'])
    expect(result.body?.props?.htmlAttributes).toEqual({
      'data-bg-src': './hero.png',
      id: 'page-root',
    })
    expect(result.body?.inlineStyles).toEqual({
      backgroundImage: "url('./hero.png')",
      color: 'white',
    })
  })
})

// ---------------------------------------------------------------------------
// 1. Heading / paragraph / inline phrasing → base.text
// ---------------------------------------------------------------------------

describe('base.text — headings h1-h6', () => {
  it('h1 → moduleId base.text, tag "h1", text matches textContent', () => {
    const node = single('<h1>Hello World</h1>')
    expect(node.moduleId).toBe('base.text')
    expect(node.props.tag).toBe('h1')
    expect(node.props.text).toBe('Hello World')
  })

  it('h2 → tag "h2"', () => {
    const node = single('<h2>Section</h2>')
    expect(node.moduleId).toBe('base.text')
    expect(node.props.tag).toBe('h2')
  })

  it('h3 → tag "h3"', () => {
    const props = singleProps('<h3>Sub-section</h3>')
    expect(props.tag).toBe('h3')
  })

  it('h4 → tag "h4"', () => {
    expect(singleProps('<h4>Minor heading</h4>').tag).toBe('h4')
  })

  it('h5 → tag "h5"', () => {
    expect(singleProps('<h5>Small heading</h5>').tag).toBe('h5')
  })

  it('h6 → tag "h6"', () => {
    expect(singleProps('<h6>Tiny heading</h6>').tag).toBe('h6')
  })

  it('heading with nested markup recurses, preserving the inline structure + spacing', () => {
    // A heading that wraps element children (e.g. <strong>, <br>) becomes a
    // container so the nested markup survives instead of being flattened into
    // one merged string. The inline space around the <strong> is preserved.
    const result = single('<h2>Bold <strong>word</strong> here</h2>')
    expect(result.moduleId).toBe('base.container')
    expect(result.props.customTag).toBe('h2')
  })

  it('heading nested markup — child text keeps the spaces around inline elements', () => {
    const result = importHtml('<h2>Bold <strong>word</strong> here</h2>')
    const h2 = result.nodes[result.rootIds[0]!]!
    const texts = h2.children
      .map((id) => result.nodes[id]!)
      .filter((n) => n.moduleId === 'base.text' && n.props.tag === 'none')
      .map((n) => n.props.text)
    // "Bold " (trailing space kept) and " here" (leading space kept) so the
    // rendered heading reads "Bold word here", not "Boldwordhere".
    expect(texts).toContain('Bold ')
    expect(texts).toContain(' here')
  })
})

describe('base.text — paragraph and inline phrasing', () => {
  it('p → moduleId base.text, tag "p", text matches textContent', () => {
    const node = single('<p>Hello paragraph</p>')
    expect(node.moduleId).toBe('base.text')
    expect(node.props.tag).toBe('p')
    expect(node.props.text).toBe('Hello paragraph')
  })

  it('span → tag "span"', () => {
    const node = single('<span>Inline text</span>')
    expect(node.moduleId).toBe('base.text')
    expect(node.props.tag).toBe('span')
    expect(node.props.text).toBe('Inline text')
  })

  it('small → tag "small"', () => {
    const node = single('<small>Fine print</small>')
    expect(node.moduleId).toBe('base.text')
    expect(node.props.tag).toBe('small')
  })

  it('strong → tag "strong"', () => {
    const node = single('<strong>Bold content</strong>')
    expect(node.moduleId).toBe('base.text')
    expect(node.props.tag).toBe('strong')
    expect(node.props.text).toBe('Bold content')
  })

  it('em → tag "em"', () => {
    const node = single('<em>Italic content</em>')
    expect(node.moduleId).toBe('base.text')
    expect(node.props.tag).toBe('em')
    expect(node.props.text).toBe('Italic content')
  })

  it('empty p → text is empty string', () => {
    const node = single('<p></p>')
    expect(node.moduleId).toBe('base.text')
    expect(node.props.text).toBe('')
  })
})

// ---------------------------------------------------------------------------
// 2. Anchors: plain <a> → base.link (prop `text`); <a class="btn"> → base.button
// ---------------------------------------------------------------------------

describe('base.link — plain <a> elements', () => {
  it('plain anchor → moduleId base.link', () => {
    const node = single('<a href="https://example.com">Visit us</a>')
    expect(node.moduleId).toBe('base.link')
  })

  it('plain anchor has `text` prop (NOT `label`)', () => {
    const node = single('<a href="https://example.com">Visit us</a>')
    expect(node.props.text).toBe('Visit us')
    expect('label' in node.props).toBe(false)
  })

  it('plain anchor captures href', () => {
    const node = single('<a href="https://example.com/page">Link</a>')
    expect(node.props.href).toBe('https://example.com/page')
  })

  it('plain anchor captures target="_blank"', () => {
    const node = single('<a href="/" target="_blank">Open</a>')
    expect(node.props.target).toBe('_blank')
  })

  it('plain anchor with no target → defaults to "_self"', () => {
    const node = single('<a href="/about">About</a>')
    expect(node.props.target).toBe('_self')
  })

  it('plain anchor with empty href → href is empty string', () => {
    const node = single('<a href="">Empty</a>')
    expect(node.props.href).toBe('')
  })

  it('<a> without any class (other than btn) → base.link, not base.button', () => {
    const node = single('<a class="nav-link" href="/home">Home</a>')
    expect(node.moduleId).toBe('base.link')
    expect(node.props.text).toBe('Home')
  })
})

describe('base.button — <a class="btn"> elements', () => {
  it('<a class="btn"> → moduleId base.button (NOT base.link)', () => {
    const node = single('<a class="btn" href="/signup">Sign Up</a>')
    expect(node.moduleId).toBe('base.button')
  })

  it('<a class="btn"> has `label` prop (NOT `text`)', () => {
    const node = single('<a class="btn" href="/signup">Sign Up</a>')
    expect(node.props.label).toBe('Sign Up')
    expect('text' in node.props).toBe(false)
  })

  it('<a class="btn"> captures href', () => {
    const node = single('<a class="btn" href="/buy">Buy Now</a>')
    expect(node.props.href).toBe('/buy')
  })

  it('<a class="btn"> captures target', () => {
    const node = single('<a class="btn" href="/docs" target="_blank">Docs</a>')
    expect(node.props.target).toBe('_blank')
  })

  it('<a class="btn"> with no target → defaults to "_self"', () => {
    const node = single('<a class="btn" href="/try">Try it</a>')
    expect(node.props.target).toBe('_self')
  })

  it('<a class="btn primary"> — btn is present among other classes → still base.button', () => {
    const node = single('<a class="btn primary large" href="/x">CTA</a>')
    expect(node.moduleId).toBe('base.button')
  })
})

// ---------------------------------------------------------------------------
// 3. <img> → base.image (src only, NO alt prop)
// ---------------------------------------------------------------------------

describe('base.image — <img> elements', () => {
  it('<img src> → moduleId base.image', () => {
    const node = single('<img src="/photo.jpg">')
    expect(node.moduleId).toBe('base.image')
  })

  it('<img src> captures src attribute', () => {
    const node = single('<img src="/photo.jpg">')
    expect(node.props.src).toBe('/photo.jpg')
  })

  it('<img src alt> — alt is NOT stored as a prop (alt comes from the media library)', () => {
    const node = single('<img src="/photo.jpg" alt="A beautiful photo">')
    expect(node.moduleId).toBe('base.image')
    expect(node.props.src).toBe('/photo.jpg')
    // alt must NOT be on the node — it comes from the media library asset only
    expect('alt' in node.props).toBe(false)
  })

  it('<img> with empty src → src is empty string', () => {
    const node = single('<img src="">')
    expect(node.props.src).toBe('')
  })

  it('<img> with no src → src is empty string', () => {
    const node = single('<img>')
    expect(node.props.src).toBe('')
  })

  it('<img> has no children (is a leaf)', () => {
    const node = single('<img src="/a.png">')
    expect(node.children).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 4. <button> → base.button (label + disabled)
// ---------------------------------------------------------------------------

describe('base.button — <button> elements', () => {
  it('<button> → moduleId base.button', () => {
    const node = single('<button>Click Me</button>')
    expect(node.moduleId).toBe('base.button')
  })

  it('<button> captures label from textContent', () => {
    const node = single('<button>Submit</button>')
    expect(node.props.label).toBe('Submit')
  })

  it('<button disabled> → disabled: true', () => {
    const node = single('<button disabled>Save</button>')
    expect(node.props.disabled).toBe(true)
  })

  it('<button> without disabled → disabled: false', () => {
    const node = single('<button>Save</button>')
    expect(node.props.disabled).toBe(false)
  })

  it('<button disabled=""> (empty string attribute) → disabled: true', () => {
    const node = single('<button disabled="">Go</button>')
    expect(node.props.disabled).toBe(true)
  })

  it('<button> is a leaf (no children)', () => {
    const node = single('<button>Action</button>')
    expect(node.children).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 5. Form elements → base form primitives
// ---------------------------------------------------------------------------

describe('base form primitives — semantic form elements', () => {
  it('imports a contact form as first-class form, label, input, textarea, and submit modules', () => {
    const result = imported(`
      <form id="contact" action="/contact" method="post">
        <label for="email">Email address</label>
        <input id="email" name="email" type="email" required placeholder="you@example.com" minlength="5">
        <textarea id="message" name="message" required maxlength="500">Hello</textarea>
        <button type="submit">Send</button>
      </form>
    `)

    const form = result.nodes[result.rootIds[0]!]!
    expect(form.moduleId).toBe('base.form')
    expect(form.props.mode).toBe('custom')
    expect(form.props.formId).toBe('contact')
    expect(form.props.action).toBe('/contact')
    expect(form.props.method).toBe('post')
    expect(form.children).toHaveLength(4)

    const label = result.nodes[form.children[0]!]!
    expect(label.moduleId).toBe('base.label')
    expect(label.props.text).toBe('Email address')
    expect(label.props.targetMode).toBe('explicit')
    expect(label.props.targetId).toBe('email')

    const input = result.nodes[form.children[1]!]!
    expect(input.moduleId).toBe('base.input')
    expect(input.props.inputType).toBe('email')
    expect(input.props.fieldId).toBe('email')
    expect(input.props.name).toBe('email')
    expect(input.props.id).toBe('email')
    expect(input.props.placeholder).toBe('you@example.com')
    expect(input.props.required).toBe(true)
    expect(input.props.minLength).toBe(5)

    const textarea = result.nodes[form.children[2]!]!
    expect(textarea.moduleId).toBe('base.textarea')
    expect(textarea.props.fieldId).toBe('message')
    expect(textarea.props.value).toBe('Hello')
    expect(textarea.props.required).toBe(true)
    expect(textarea.props.maxLength).toBe(500)

    const submit = result.nodes[form.children[3]!]!
    expect(submit.moduleId).toBe('base.submit')
    expect(submit.props.label).toBe('Send')
  })

  it('imports checkbox, radio, select, optgroup, option, and input-submit elements as form modules', () => {
    const result = imported(`
      <form name="signup">
        <input type="checkbox" name="consent" value="yes" checked required>
        <input type="radio" name="plan" value="pro" checked>
        <select id="country" name="country" required multiple>
          <optgroup label="Europe">
            <option value="cz" selected>Czechia</option>
          </optgroup>
        </select>
        <input type="submit" value="Join">
      </form>
    `)

    const form = result.nodes[result.rootIds[0]!]!
    expect(form.moduleId).toBe('base.form')
    expect(form.props.formId).toBe('signup')
    expect(form.children).toHaveLength(4)

    const checkbox = result.nodes[form.children[0]!]!
    expect(checkbox.moduleId).toBe('base.checkbox')
    expect(checkbox.props.fieldId).toBe('consent')
    expect(checkbox.props.value).toBe('yes')
    expect(checkbox.props.checked).toBe(true)
    expect(checkbox.props.required).toBe(true)

    const radio = result.nodes[form.children[1]!]!
    expect(radio.moduleId).toBe('base.radio')
    expect(radio.props.fieldId).toBe('plan')
    expect(radio.props.value).toBe('pro')
    expect(radio.props.checked).toBe(true)

    const select = result.nodes[form.children[2]!]!
    expect(select.moduleId).toBe('base.select')
    expect(select.props.fieldId).toBe('country')
    expect(select.props.required).toBe(true)
    expect(select.props.multiple).toBe(true)

    const group = result.nodes[select.children[0]!]!
    expect(group.moduleId).toBe('base.option-group')
    expect(group.props.label).toBe('Europe')

    const option = result.nodes[group.children[0]!]!
    expect(option.moduleId).toBe('base.option')
    expect(option.props.value).toBe('cz')
    expect(option.props.label).toBe('Czechia')
    expect(option.props.selected).toBe(true)

    const submit = result.nodes[form.children[3]!]!
    expect(submit.moduleId).toBe('base.submit')
    expect(submit.props.label).toBe('Join')
  })

  it('keeps a wrapping label as a container so nested controls are not dropped', () => {
    const result = imported('<form><label>Email <input name="email" type="email"></label></form>')
    const form = result.nodes[result.rootIds[0]!]!
    const labelContainer = result.nodes[form.children[0]!]!

    expect(labelContainer.moduleId).toBe('base.container')
    expect(labelContainer.props.customTag).toBe('label')
    expect(labelContainer.children).toHaveLength(2)
    expect(result.nodes[labelContainer.children[1]!]!.moduleId).toBe('base.input')
  })
})

// ---------------------------------------------------------------------------
// 6. <ul> / <ol> → base.container (builtin tag) + recurse into <li> children
// ---------------------------------------------------------------------------

describe('base.container — <ul> and <ol> (builtin tags)', () => {
  it('<ul> → moduleId base.container with tag "ul"', () => {
    const node = single('<ul></ul>')
    expect(node.moduleId).toBe('base.container')
    expect(node.props.tag).toBe('ul')
  })

  it('<ol> → moduleId base.container with tag "ol"', () => {
    const node = single('<ol></ol>')
    expect(node.moduleId).toBe('base.container')
    expect(node.props.tag).toBe('ol')
  })

  it('<ul> with <li> children → children are recursed and present in nodes map', () => {
    const result = imported('<ul><li>Item 1</li><li>Item 2</li></ul>')

    // One root node (the ul)
    expect(result.rootIds).toHaveLength(1)
    const ulId = result.rootIds[0]!
    const ulNode = result.nodes[ulId]!
    expect(ulNode.moduleId).toBe('base.container')
    expect(ulNode.props.tag).toBe('ul')

    // Two child nodes
    expect(ulNode.children).toHaveLength(2)

    // Each child is in the flat nodes map
    for (const childId of ulNode.children) {
      const childNode = result.nodes[childId]
      expect(childNode).toBeDefined()
    }
  })

  it('<li> children become base.container with tag:"custom", customTag:"li"', () => {
    const result = imported('<ul><li>First</li></ul>')
    const ulId = result.rootIds[0]!
    const ulNode = result.nodes[ulId]!
    const liId = ulNode.children[0]!
    const liNode = result.nodes[liId]!

    // <li> is not in BUILTIN_HTML_TAGS → catch-all: tag:'custom', customTag:'li'
    expect(liNode.moduleId).toBe('base.container')
    expect(liNode.props.tag).toBe('custom')
    expect(liNode.props.customTag).toBe('li')
  })

  it('<ol> children are correct — li uses tag:"custom"', () => {
    const result = imported('<ol><li>A</li><li>B</li><li>C</li></ol>')
    const olId = result.rootIds[0]!
    const olNode = result.nodes[olId]!
    expect(olNode.children).toHaveLength(3)

    for (const childId of olNode.children) {
      const child = result.nodes[childId]!
      expect(child.props.tag).toBe('custom')
      expect(child.props.customTag).toBe('li')
    }
  })
})

// ---------------------------------------------------------------------------
// 6. Semantic containers → base.container with builtin tag + recurse
// ---------------------------------------------------------------------------

describe('base.container — semantic container tags (BUILTIN_HTML_TAGS)', () => {
  const builtinTags = ['div', 'section', 'article', 'main', 'header', 'footer', 'nav', 'aside']

  for (const tag of builtinTags) {
    it(`<${tag}> → base.container with tag "${tag}"`, () => {
      const node = single(`<${tag}></${tag}>`)
      expect(node.moduleId).toBe('base.container')
      expect(node.props.tag).toBe(tag)
    })
  }

  it('nested div > h1 + p — parent tag is "div", children are recursed', () => {
    const result = imported('<div><h1>Title</h1><p>Body</p></div>')
    const divId = result.rootIds[0]!
    const divNode = result.nodes[divId]!
    expect(divNode.moduleId).toBe('base.container')
    expect(divNode.props.tag).toBe('div')
    expect(divNode.children).toHaveLength(2)

    const h1Node = result.nodes[divNode.children[0]!]!
    expect(h1Node.moduleId).toBe('base.text')
    expect(h1Node.props.tag).toBe('h1')

    const pNode = result.nodes[divNode.children[1]!]!
    expect(pNode.moduleId).toBe('base.text')
    expect(pNode.props.tag).toBe('p')
  })

  it('<section> with children produces children in nodes map', () => {
    const result = imported('<section><h2>Section heading</h2></section>')
    const sectionId = result.rootIds[0]!
    const sectionNode = result.nodes[sectionId]!
    expect(sectionNode.props.tag).toBe('section')
    expect(sectionNode.children).toHaveLength(1)
    const heading = result.nodes[sectionNode.children[0]!]!
    expect(heading.props.tag).toBe('h2')
  })

  it('<article> → base.container with tag "article"', () => {
    const node = single('<article></article>')
    expect(node.props.tag).toBe('article')
  })

  it('<header> + <footer> at root level → both base.container nodes', () => {
    const result = imported('<header>Top</header><footer>Bottom</footer>')
    expect(result.rootIds).toHaveLength(2)
    const [headerId, footerId] = result.rootIds
    expect(result.nodes[headerId!]!.props.tag).toBe('header')
    expect(result.nodes[footerId!]!.props.tag).toBe('footer')
  })

  it('<nav> → tag "nav"', () => {
    expect(singleProps('<nav></nav>').tag).toBe('nav')
  })

  it('<aside> → tag "aside"', () => {
    expect(singleProps('<aside></aside>').tag).toBe('aside')
  })

  it('<main> → tag "main"', () => {
    expect(singleProps('<main></main>').tag).toBe('main')
  })
})

// ---------------------------------------------------------------------------
// 7. <figure> / <blockquote> → base.container with tag:"custom" + customTag
// ---------------------------------------------------------------------------

describe('base.container — custom tag (NOT in BUILTIN_HTML_TAGS)', () => {
  it('<figure> → base.container tag:"custom", customTag:"figure"', () => {
    const node = single('<figure></figure>')
    expect(node.moduleId).toBe('base.container')
    expect(node.props.tag).toBe('custom')
    expect(node.props.customTag).toBe('figure')
  })

  it('<blockquote> → base.container tag:"custom", customTag:"blockquote"', () => {
    const node = single('<blockquote><p>Quote text</p></blockquote>')
    expect(node.moduleId).toBe('base.container')
    expect(node.props.tag).toBe('custom')
    expect(node.props.customTag).toBe('blockquote')
  })

  it('<figure> recurses into children', () => {
    const result = imported('<figure><img src="/a.png"><figcaption>Caption</figcaption></figure>')
    const figId = result.rootIds[0]!
    const figNode = result.nodes[figId]!
    expect(figNode.children).toHaveLength(2)

    const imgNode = result.nodes[figNode.children[0]!]!
    expect(imgNode.moduleId).toBe('base.image')

    const captionNode = result.nodes[figNode.children[1]!]!
    expect(captionNode.moduleId).toBe('base.container')
    expect(captionNode.props.tag).toBe('custom')
    expect(captionNode.props.customTag).toBe('figcaption')
  })

  it('<li> → base.container tag:"custom", customTag:"li"', () => {
    // li is not in BUILTIN_HTML_TAGS — only reachable via catch-all (or from ul/ol)
    const node = single('<li>Item</li>')
    expect(node.moduleId).toBe('base.container')
    expect(node.props.tag).toBe('custom')
    expect(node.props.customTag).toBe('li')
  })
})

// ---------------------------------------------------------------------------
// 8. Void elements → base.container with tag:"custom", recurse:false
// ---------------------------------------------------------------------------

describe('void elements — childless base.container with customTag', () => {
  // The void-element rule sits before the catch-all and maps the standard
  // HTML void elements to base.container with tag:'custom' + the actual tag
  // name as customTag. recurse is NOT set, so these nodes have no children.

  it('<br> → base.container tag:"custom", customTag:"br", no children', () => {
    const node = single('<br>')
    expect(node.moduleId).toBe('base.container')
    expect(node.props.tag).toBe('custom')
    expect(node.props.customTag).toBe('br')
    expect(node.children).toHaveLength(0)
  })

  it('<hr> → base.container tag:"custom", customTag:"hr", no children', () => {
    const node = single('<hr>')
    expect(node.moduleId).toBe('base.container')
    expect(node.props.tag).toBe('custom')
    expect(node.props.customTag).toBe('hr')
    expect(node.children).toHaveLength(0)
  })

  it('<area> → base.container tag:"custom", customTag:"area", no children', () => {
    const node = single('<area>')
    expect(node.moduleId).toBe('base.container')
    expect(node.props.tag).toBe('custom')
    expect(node.props.customTag).toBe('area')
    expect(node.children).toHaveLength(0)
  })

  it('<source> → base.container tag:"custom", customTag:"source", no children', () => {
    const node = single('<source>')
    expect(node.moduleId).toBe('base.container')
    expect(node.props.tag).toBe('custom')
    expect(node.props.customTag).toBe('source')
    expect(node.children).toHaveLength(0)
  })

  it('<wbr> → base.container tag:"custom", customTag:"wbr", no children', () => {
    const node = single('<wbr>')
    expect(node.moduleId).toBe('base.container')
    expect(node.props.tag).toBe('custom')
    expect(node.props.customTag).toBe('wbr')
    expect(node.children).toHaveLength(0)
  })

  it('<track> → base.container tag:"custom", customTag:"track", no children', () => {
    const node = single('<track>')
    expect(node.moduleId).toBe('base.container')
    expect(node.props.tag).toBe('custom')
    expect(node.props.customTag).toBe('track')
    expect(node.children).toHaveLength(0)
  })

  it('void elements mixed with normal elements produce one node each, all childless', () => {
    const result = imported('<br><hr><wbr>')
    expect(result.rootIds).toHaveLength(3)
    for (const id of result.rootIds) {
      const node = result.nodes[id]!
      expect(node.moduleId).toBe('base.container')
      expect(node.props.tag).toBe('custom')
      expect(node.children).toHaveLength(0)
    }
  })

  it('void element inside a container does not pull children out of the container', () => {
    // <div> contains <br> and <p>. The br must be childless.
    const result = imported('<div><br><p>After break</p></div>')
    const divId = result.rootIds[0]!
    const divNode = result.nodes[divId]!
    expect(divNode.children).toHaveLength(2)

    const brNode = result.nodes[divNode.children[0]!]!
    expect(brNode.props.customTag).toBe('br')
    expect(brNode.children).toHaveLength(0)

    const pNode = result.nodes[divNode.children[1]!]!
    expect(pNode.moduleId).toBe('base.text')
  })
})

// ---------------------------------------------------------------------------
// 9. Catch-all: exotic tags → base.container with tag:"custom"
// ---------------------------------------------------------------------------

describe('catch-all guarantee — exotic / unknown tags', () => {
  it('<dialog> → base.container tag:"custom", customTag:"dialog"', () => {
    const node = single('<dialog></dialog>')
    expect(node.moduleId).toBe('base.container')
    expect(node.props.tag).toBe('custom')
    expect(node.props.customTag).toBe('dialog')
  })

  it('<table> → base.container tag:"custom", customTag:"table"', () => {
    const node = single('<table></table>')
    expect(node.moduleId).toBe('base.container')
    expect(node.props.tag).toBe('custom')
    expect(node.props.customTag).toBe('table')
  })

  it('<details> → base.container tag:"custom", customTag:"details"', () => {
    const node = single('<details></details>')
    expect(node.moduleId).toBe('base.container')
    expect(node.props.tag).toBe('custom')
    expect(node.props.customTag).toBe('details')
  })

  it('<address> → base.container tag:"custom", customTag:"address"', () => {
    const node = single('<address></address>')
    expect(node.moduleId).toBe('base.container')
    expect(node.props.tag).toBe('custom')
    expect(node.props.customTag).toBe('address')
  })

  it('every element produces exactly one node (no falls-through)', () => {
    // Three exotic tags → exactly three nodes
    const result = imported('<dialog>D</dialog><table></table><details></details>')
    expect(result.rootIds).toHaveLength(3)
    for (const id of result.rootIds) {
      const node = result.nodes[id]!
      expect(node).toBeDefined()
      expect(node.moduleId).toBe('base.container')
      expect(node.props.tag).toBe('custom')
    }
  })

  it('a deeply-exotic tag still yields one node per element', () => {
    const result = imported('<wbr></wbr>')
    expect(result.rootIds).toHaveLength(1)
    const node = result.nodes[result.rootIds[0]!]!
    expect(node.moduleId).toBe('base.container')
    expect(node.props.tag).toBe('custom')
    expect(node.props.customTag).toBe('wbr')
  })
})

// ---------------------------------------------------------------------------
// 9. Strip safety — <script> + inline event handlers dropped; <style> CSS
//    harvested to styleCss; inline style="" preserved on node.inlineStyles
// ---------------------------------------------------------------------------

describe('stripUnsafe — <script> elements', () => {
  it('<script> is stripped: not present in nodes, stripped.scripts incremented', () => {
    const result = imported('<script>alert("xss")</script><p>Safe</p>')
    // The paragraph is the only root; no script node
    expect(result.rootIds).toHaveLength(1)
    const root = result.nodes[result.rootIds[0]!]!
    expect(root.moduleId).toBe('base.text')
    expect(result.stripped.scripts).toBe(1)
  })

  it('multiple <script> tags — all stripped and counted', () => {
    const result = imported('<script>a()</script><script>b()</script><div></div>')
    expect(result.stripped.scripts).toBe(2)
    expect(result.rootIds).toHaveLength(1) // only the div
  })
})

describe('collectStyleCss — <style> elements', () => {
  it('<style> CSS is harvested into result.styleCss (not dropped)', () => {
    const result = imported('<style>body { color: red; }</style><p>Text</p>')
    expect(result.styleCss).toContain('color: red')
    // The <style> element itself is removed from the node tree.
    expect(result.rootIds).toHaveLength(1)
    expect(result.nodes[result.rootIds[0]!]!.moduleId).toBe('base.text')
  })

  it('multiple <style> tags are concatenated into styleCss', () => {
    const result = imported('<style>.a{color:red}</style><style>.b{color:blue}</style><h1>Title</h1>')
    expect(result.styleCss).toContain('.a')
    expect(result.styleCss).toContain('.b')
    expect(result.rootIds).toHaveLength(1)
  })

  it('styleCss is empty when the source has no <style> blocks', () => {
    const result = imported('<p>No styles here</p>')
    expect(result.styleCss).toBe('')
  })
})

describe('stripUnsafe — inline event handlers (on*)', () => {
  it('onclick="" on a root element → stripped.inlineHandlers incremented', () => {
    // We use a div (recurse=true container) so the inline handler can exist on
    // an element that survives. The node must still be created.
    const result = imported('<div onclick="doSomething()"></div>')
    expect(result.stripped.inlineHandlers).toBe(1)
    // The div node must still be present
    expect(result.rootIds).toHaveLength(1)
    const node = result.nodes[result.rootIds[0]!]!
    expect(node.moduleId).toBe('base.container')
  })

  it('multiple on* attributes count individually', () => {
    const result = imported('<div onmouseover="a()" onkeydown="b()" onfocus="c()"></div>')
    expect(result.stripped.inlineHandlers).toBe(3)
  })

  it('on* attributes on nested elements are counted', () => {
    const result = imported('<div><p onclick="x()">Text</p></div>')
    expect(result.stripped.inlineHandlers).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Inline style="" → node.inlineStyles (preserved, security-gated)
// ---------------------------------------------------------------------------

describe('inline style="" → node.inlineStyles', () => {
  it('preserves every declaration as a camelCase bag on the node', () => {
    const node = single('<div style="color:red;font-size:12px"></div>')
    expect(node.inlineStyles?.color).toBe('red')
    expect(node.inlineStyles?.fontSize).toBe('12px')
  })

  it('preserves inline styles on a leaf element (p) too', () => {
    const node = single('<p style="margin:0">Content</p>')
    expect(node.moduleId).toBe('base.text')
    // The `margin` shorthand expands to longhands in the CSSOM enumeration.
    expect(node.inlineStyles?.marginTop).toBe('0px')
  })

  it('captures background-image alongside other declarations', () => {
    const node = single(`<div style="background-image: url('img/bg.png'); padding: 20px">Hi</div>`)
    expect(node.inlineStyles?.backgroundImage).toContain('img/bg.png')
    // Non-background declarations are now preserved too (full inline styles).
    expect(node.inlineStyles?.paddingTop).toBe('20px')
  })

  it('canonicalises a url() from a background shorthand', () => {
    const node = single(
      `<section style="background: url(hero.jpg) no-repeat center / cover">x</section>`,
    )
    expect(node.inlineStyles?.backgroundImage).toContain('hero.jpg')
    expect(node.inlineStyles?.backgroundRepeat).toBe('no-repeat')
  })

  it('captures a colour-only background (now in scope)', () => {
    const node = single(`<div style="background: #fff; color: red">x</div>`)
    expect(node.inlineStyles?.color).toBe('red')
    // The background shorthand (or its expanded longhands) is retained.
    expect(Object.keys(node.inlineStyles ?? {}).length).toBeGreaterThan(0)
  })

  it('preserves shorthand+var() declarations byte-faithfully', () => {
    // CSSOM views of substitution declarations are lossy and engine-divergent;
    // the harvest re-encodes them as marker custom properties before parsing
    // (see @core/css-substitution).
    const node = single(`<div style="border: 1px solid var(--rule); color: var(--ink); padding: 4px">x</div>`)
    expect(node.inlineStyles?.border).toBe('1px solid var(--rule)')
    expect(node.inlineStyles?.color).toBe('var(--ink)')
    expect(node.inlineStyles?.paddingTop).toBe('4px')
    // No mangled longhand artifacts carrying the bare var() text.
    expect(node.inlineStyles?.borderLeftWidth).toBeUndefined()
  })

  it('leaves nodes without inline styles free of inlineStyles', () => {
    const result = importHtml('<div><p>Plain</p></div>')
    for (const node of Object.values(result.nodes)) {
      expect(node.inlineStyles).toBeUndefined()
    }
  })

  it('attaches each element’s inline styles to its own node', () => {
    const result = importHtml(
      `<div style="background-image:url(a.png)"></div><div style="background-image:url(b.png)"></div>`,
    )
    const urls = Object.values(result.nodes)
      .map((n) => n.inlineStyles?.backgroundImage)
      .filter(Boolean)
      .join(' ')
    expect(urls).toContain('a.png')
    expect(urls).toContain('b.png')
  })
})

// ---------------------------------------------------------------------------
// 10. Class preservation: el.classList → node.classIds verbatim
// ---------------------------------------------------------------------------

describe('class preservation — node.classIds from el.classList', () => {
  it('single class → classIds is ["that-class"]', () => {
    const node = single('<p class="intro">Text</p>')
    expect(node.classIds).toEqual(['intro'])
  })

  it('multiple classes → classIds preserves order verbatim', () => {
    const node = single('<div class="foo bar"></div>')
    expect(node.classIds).toEqual(['foo', 'bar'])
  })

  it('three classes in order', () => {
    const node = single('<section class="hero fullwidth padded"></section>')
    expect(node.classIds).toEqual(['hero', 'fullwidth', 'padded'])
  })

  it('element without class → classIds is empty array', () => {
    const node = single('<p>No classes</p>')
    expect(node.classIds).toEqual([])
  })

  it('container node preserves its classes', () => {
    const node = single('<div class="card shadow-lg rounded"></div>')
    expect(node.classIds).toEqual(['card', 'shadow-lg', 'rounded'])
  })

  it('button node preserves its classes', () => {
    const node = single('<button class="btn-primary large">Go</button>')
    expect(node.classIds).toEqual(['btn-primary', 'large'])
  })
})

// ---------------------------------------------------------------------------
// 10b. HTML attribute preservation: ordinary authored elements → props.htmlAttributes
// ---------------------------------------------------------------------------

describe('HTML attribute preservation — props.htmlAttributes for ordinary base modules', () => {
  it('preserves safe HTML attributes on container, text, link, button, and image nodes', () => {
    const result = imported(`
      <div id="preloader" role="region">
        <p id="intro-copy" aria-label="Intro">Intro</p>
        <a id="jump-link" data-track="jump" href="#target">Jump</a>
        <button id="back-top" data-bs-toggle="modal">Top</button>
        <img id="logo-image" data-lazy="logo" src="/logo.png">
      </div>
    `)

    const container = result.nodes[result.rootIds[0]!]!
    expect(container.moduleId).toBe('base.container')
    expect(container.props.htmlAttributes).toEqual({ id: 'preloader', role: 'region' })

    const children = container.children.map((id) => result.nodes[id]!)
    expect(children[0]!.moduleId).toBe('base.text')
    expect(children[0]!.props.htmlAttributes).toEqual({
      'aria-label': 'Intro',
      id: 'intro-copy',
    })
    expect(children[1]!.moduleId).toBe('base.link')
    expect(children[1]!.props.htmlAttributes).toEqual({
      'data-track': 'jump',
      id: 'jump-link',
    })
    expect(children[2]!.moduleId).toBe('base.button')
    expect(children[2]!.props.htmlAttributes).toEqual({
      'data-bs-toggle': 'modal',
      id: 'back-top',
    })
    expect(children[3]!.moduleId).toBe('base.image')
    expect(children[3]!.props.htmlAttributes).toEqual({
      'data-lazy': 'logo',
      id: 'logo-image',
    })
  })

  it('keeps form control id props on form modules instead of adding htmlAttributes', () => {
    const result = imported('<form><input id="email" name="email"></form>')
    const form = result.nodes[result.rootIds[0]!]!
    const input = result.nodes[form.children[0]!]!

    expect(input.moduleId).toBe('base.input')
    expect(input.props.id).toBe('email')
    expect(input.props.htmlAttributes).toBeUndefined()
  })

  it('skips class, module-owned attributes, and reserved editor attributes', () => {
    const result = imported(`
      <div class="kept-as-class" data-bg-src="assets/images/shape/heroShape1_1.png" data-instatic-node="reserved">
        <a href="#target" target="_blank" rel="nofollow" data-track="jump">Jump</a>
        <img src="/logo.png" alt="Logo" data-lazy="logo">
      </div>
    `)

    const container = result.nodes[result.rootIds[0]!]!
    expect(container.moduleId).toBe('base.container')
    expect(container.classIds).toEqual(['kept-as-class'])
    expect(container.props.htmlAttributes).toEqual({
      'data-bg-src': 'assets/images/shape/heroShape1_1.png',
    })

    const children = container.children.map((id) => result.nodes[id]!)
    expect(children[0]!.moduleId).toBe('base.link')
    expect(children[0]!.props.htmlAttributes).toEqual({ 'data-track': 'jump' })
    expect(children[1]!.moduleId).toBe('base.image')
    expect(children[1]!.props.htmlAttributes).toEqual({ 'data-lazy': 'logo' })
  })
})

// ---------------------------------------------------------------------------
// 11. Nested snippets — parent / child structure
// ---------------------------------------------------------------------------

describe('nested structure — parent/child IDs in document order', () => {
  it('section > h1 + p + a.btn → correct rootIds count, child count, child moduleIds', () => {
    const result = imported(`
      <section>
        <h1>Hero Title</h1>
        <p>Hero subtitle text here.</p>
        <a class="btn" href="/start">Get Started</a>
      </section>
    `)

    // One root: the section
    expect(result.rootIds).toHaveLength(1)
    const sectionId = result.rootIds[0]!
    const sectionNode = result.nodes[sectionId]!

    expect(sectionNode.moduleId).toBe('base.container')
    expect(sectionNode.props.tag).toBe('section')
    expect(sectionNode.children).toHaveLength(3)

    // Children in document order: h1, p, a.btn
    const [h1Id, pId, btnId] = sectionNode.children
    expect(result.nodes[h1Id!]!.moduleId).toBe('base.text')
    expect(result.nodes[h1Id!]!.props.tag).toBe('h1')

    expect(result.nodes[pId!]!.moduleId).toBe('base.text')
    expect(result.nodes[pId!]!.props.tag).toBe('p')

    expect(result.nodes[btnId!]!.moduleId).toBe('base.button')
    expect(result.nodes[btnId!]!.props.label).toBe('Get Started')
  })

  it('ul > 3 li items → ul has exactly 3 children, all li', () => {
    const result = imported('<ul><li>A</li><li>B</li><li>C</li></ul>')
    const ulId = result.rootIds[0]!
    const ulNode = result.nodes[ulId]!
    expect(ulNode.children).toHaveLength(3)

    for (const childId of ulNode.children) {
      const liNode = result.nodes[childId]!
      expect(liNode.moduleId).toBe('base.container')
      expect(liNode.props.tag).toBe('custom')
      expect(liNode.props.customTag).toBe('li')
    }
  })

  it('all nodes across a nested tree are present in the flat nodes map', () => {
    const result = imported('<nav><ul><li><a href="/">Home</a></li></ul></nav>')

    // nav (root) → ul → li → a
    expect(result.rootIds).toHaveLength(1)
    const navId = result.rootIds[0]!
    const navNode = result.nodes[navId]!
    expect(navNode.props.tag).toBe('nav')

    const ulId = navNode.children[0]!
    const ulNode = result.nodes[ulId]!
    expect(ulNode.props.tag).toBe('ul')

    const liId = ulNode.children[0]!
    const liNode = result.nodes[liId]!
    expect(liNode.props.tag).toBe('custom')
    expect(liNode.props.customTag).toBe('li')

    const aId = liNode.children[0]!
    const aNode = result.nodes[aId]!
    expect(aNode.moduleId).toBe('base.link')
    expect(aNode.props.href).toBe('/')
  })

  it('two sibling top-level blocks → rootIds has length 2, in document order', () => {
    const result = imported('<h1>Title</h1><p>Body</p>')
    expect(result.rootIds).toHaveLength(2)

    const first = result.nodes[result.rootIds[0]!]!
    const second = result.nodes[result.rootIds[1]!]!

    expect(first.props.tag).toBe('h1')
    expect(first.props.text).toBe('Title')

    expect(second.props.tag).toBe('p')
    expect(second.props.text).toBe('Body')
  })

  it('every node ID in children arrays exists in the flat nodes map', () => {
    const result = imported(`
      <div>
        <section>
          <h2>Sub</h2>
          <p>Para</p>
        </section>
        <footer><span>Footer text</span></footer>
      </div>
    `)

    // Walk every node and verify all children exist
    for (const node of Object.values(result.nodes)) {
      for (const childId of node.children) {
        expect(result.nodes[childId]).toBeDefined()
      }
    }
  })
})

// ---------------------------------------------------------------------------
// 11b. Direct text inside recursing containers → synthesized no-wrapper base.text child
//
// Regression guard: containers used to walk only ELEMENT children, so direct
// text (e.g. `<div class="num">98%</div>`) was dropped and the container
// imported empty. The walker now preserves significant text as a base.text
// child with tag "none" in document order.
// ---------------------------------------------------------------------------

describe('direct text in containers → synthesized no-wrapper base.text', () => {
  it('text-only div → container with one no-wrapper text child carrying the text', () => {
    const result = imported('<div class="metricNum">98%</div>')
    const divNode = result.nodes[result.rootIds[0]!]!
    expect(divNode.moduleId).toBe('base.container')
    expect(divNode.children).toHaveLength(1)

    const textNode = result.nodes[divNode.children[0]!]!
    expect(textNode.moduleId).toBe('base.text')
    expect(textNode.props.tag).toBe('none')
    expect(textNode.props.text).toBe('98%')
  })

  it('text-only <li> → container with a no-wrapper text child (no longer empty)', () => {
    const result = imported('<ul><li>Buy milk</li></ul>')
    const ulNode = result.nodes[result.rootIds[0]!]!
    const liNode = result.nodes[ulNode.children[0]!]!
    expect(liNode.props.customTag).toBe('li')
    expect(liNode.children).toHaveLength(1)
    expect(result.nodes[liNode.children[0]!]!.props.text).toBe('Buy milk')
  })

  it('mixed content → text and element children interleaved in document order', () => {
    const result = imported('<div>Intro <a href="/x">link</a> outro</div>')
    const divNode = result.nodes[result.rootIds[0]!]!
    expect(divNode.children).toHaveLength(3)

    const [first, second, third] = divNode.children.map((id) => result.nodes[id]!)
    expect(first.moduleId).toBe('base.text')
    expect(first.props.tag).toBe('none')
    // The space between "Intro" and the inline <a> is significant and kept, so
    // the rendered output reads "Intro link outro" rather than "Introlinkoutro".
    expect(first.props.text).toBe('Intro ')
    expect(second.moduleId).toBe('base.link')
    expect(second.props.href).toBe('/x')
    expect(third.moduleId).toBe('base.text')
    expect(third.props.tag).toBe('none')
    expect(third.props.text).toBe(' outro')
  })

  it('mixed content after a leading element keeps boundary spaces', () => {
    const result = imported(`
      <h1>
        <span>Revolutionize</span>
        customer interplay
        for AI <span>chatbots</span>
      </h1>
    `)
    const h1Node = result.nodes[result.rootIds[0]!]!
    const [first, second, third] = h1Node.children.map((id) => result.nodes[id]!)
    expect(first.moduleId).toBe('base.text')
    expect(first.props.text).toBe('Revolutionize')
    expect(second.moduleId).toBe('base.text')
    expect(second.props.tag).toBe('none')
    expect(second.props.text).toBe(' customer interplay for AI ')
    expect(third.moduleId).toBe('base.text')
    expect(third.props.text).toBe('chatbots')
  })

  it('whitespace-only text between elements is ignored (no spurious text nodes)', () => {
    const result = imported(`
      <div>
        <span>A</span>
        <span>B</span>
      </div>
    `)
    const divNode = result.nodes[result.rootIds[0]!]!
    // Only the two <span> elements — the indentation whitespace is dropped.
    expect(divNode.children).toHaveLength(2)
    for (const id of divNode.children) {
      expect(result.nodes[id]!.moduleId).toBe('base.text')
    }
  })

  it('internal whitespace runs collapse to single spaces', () => {
    const result = imported('<div>hello\n\n   world</div>')
    const textNode = result.nodes[result.nodes[result.rootIds[0]!]!.children[0]!]!
    expect(textNode.moduleId).toBe('base.text')
    expect(textNode.props.tag).toBe('none')
    expect(textNode.props.text).toBe('hello world')
  })

  it('top-level bare text becomes a root no-wrapper text node', () => {
    const result = imported('Just some text')
    expect(result.rootIds).toHaveLength(1)
    const node = result.nodes[result.rootIds[0]!]!
    expect(node.moduleId).toBe('base.text')
    expect(node.props.tag).toBe('none')
    expect(node.props.text).toBe('Just some text')
  })
})

// ---------------------------------------------------------------------------
// 12. walkAndMap / parseHtml used independently
// ---------------------------------------------------------------------------

describe('walkAndMap + parseHtml as independent pipeline steps', () => {
  it('walkAndMap(parseHtml(source)) produces same fragment structure as importHtml', () => {
    const src = '<p>Hello</p>'
    const fromWalk = walkAndMap(parseHtml(src))
    const fromImport = importHtml(src)

    // Same count of root nodes
    expect(fromWalk.rootIds).toHaveLength(fromImport.rootIds.length)

    // Same number of nodes in the map
    expect(Object.keys(fromWalk.nodes)).toHaveLength(Object.keys(fromImport.nodes).length)

    // Root node has the same moduleId
    const walkRoot = fromWalk.nodes[fromWalk.rootIds[0]!]!
    const importRoot = fromImport.nodes[fromImport.rootIds[0]!]!
    expect(walkRoot.moduleId).toBe(importRoot.moduleId)
    expect(walkRoot.props.tag).toBe(importRoot.props.tag)
  })

  it('stripUnsafe mutates the document in place and does not affect walkAndMap separately', () => {
    const doc = parseHtml('<div onclick="bad()"><script>evil()</script><p>OK</p></div>')
    const report = stripUnsafe(doc)
    expect(report.scripts).toBe(1)
    expect(report.inlineHandlers).toBe(1)

    const fragment = walkAndMap(doc)
    // After stripping, the div + the p child remain (script was removed)
    expect(fragment.rootIds).toHaveLength(1)
    const divNode = fragment.nodes[fragment.rootIds[0]!]!
    expect(divNode.moduleId).toBe('base.container')
    // The div has the p as its only child (script is gone)
    expect(divNode.children).toHaveLength(1)
    const pNode = fragment.nodes[divNode.children[0]!]!
    expect(pNode.moduleId).toBe('base.text')
  })
})

// ---------------------------------------------------------------------------
// base.outlet — <instatic-outlet> custom element
// ---------------------------------------------------------------------------

describe('base.outlet — <instatic-outlet>', () => {
  it('maps <instatic-outlet> to a childless base.outlet node', () => {
    const node = single('<instatic-outlet></instatic-outlet>')
    expect(node.moduleId).toBe('base.outlet')
    expect(node.children ?? []).toHaveLength(0)
  })

  it('survives import alongside sibling chrome, producing one outlet node', () => {
    const result = importHtml(
      '<header>Top</header><instatic-outlet></instatic-outlet><footer>Bottom</footer>',
    )
    const outlets = Object.values(result.nodes).filter((n) => n.moduleId === 'base.outlet')
    expect(outlets).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// base.loop — <instatic-loop> custom element
// ---------------------------------------------------------------------------

describe('base.loop — <instatic-loop>', () => {
  it('maps <instatic-loop> to a configured base.loop node with child variants', () => {
    const result = importHtml(`
      <instatic-loop
        class="cards"
        data-source-id="data.rows"
        data-table-id="tbl_posts"
        data-order-by="publishedAt"
        data-direction="desc"
        data-limit="3"
        data-offset="1"
        data-pagination="infinite"
        data-page-size="2"
      >
        <article><h2>{currentEntry.title}</h2></article>
      </instatic-loop>
    `)

    expect(result.rootIds).toHaveLength(1)
    const loop = result.nodes[result.rootIds[0]!]!
    expect(loop.moduleId).toBe('base.loop')
    expect(loop.classIds).toEqual(['cards'])
    expect(loop.props).toEqual(expect.objectContaining({
      sourceId: 'data.rows',
      filters: { tableId: 'tbl_posts' },
      orderBy: 'publishedAt',
      direction: 'desc',
      limit: 3,
      offset: 1,
      pagination: 'infinite',
      pageSize: 2,
    }))
    expect(loop.children).toHaveLength(1)
    expect(result.nodes[loop.children[0]!]!.moduleId).toBe('base.container')
  })
})

// ---------------------------------------------------------------------------
// 13. Empty input and edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  it('empty string source → rootIds is empty, nodes is empty', () => {
    const result = importHtml('')
    expect(result.rootIds).toHaveLength(0)
    expect(Object.keys(result.nodes)).toHaveLength(0)
  })

  it('whitespace-only source → rootIds is empty', () => {
    const result = importHtml('   \n   ')
    expect(result.rootIds).toHaveLength(0)
  })

  it('stripped counts start at 0 and styleCss is empty when nothing is present', () => {
    const result = importHtml('<p>Clean</p>')
    expect(result.stripped.scripts).toBe(0)
    expect(result.stripped.inlineHandlers).toBe(0)
    expect(result.styleCss).toBe('')
  })
})
