import { afterEach, describe, expect, it } from 'bun:test'
import { NavItemModule } from '../index'
import { NAV_ITEM_COLLAPSED_INDENTS, navItemCollapseCss } from '../navItemCss'
import { NAV_ITEM_RUNTIME_JS } from '../navItemRuntimeJs'

const baseProps = {
  label: 'About',
  isLink: true,
  href: '/about',
  target: '_self' as const,
  htmlAttributes: {},
}

const childHtml = '<li class="instatic-nav-item">Team</li>'

describe('base.nav-item render', () => {
  it('renders a plain link li when childless', () => {
    const { html } = NavItemModule.render(baseProps as never, [])
    expect(html).toBe('<li class="instatic-nav-item"><a class="instatic-nav-item__link" href="/about" target="_self">About</a></li>')
  })

  it('renders a link, a caret toggle, and the submenu when it has children', () => {
    const { html } = NavItemModule.render(baseProps as never, [childHtml])
    expect(html).toBe(
      '<li class="instatic-nav-item" data-instatic-nav-item-state="closed">'
      + '<a class="instatic-nav-item__link" href="/about" target="_self">About</a>'
      + '<button type="button" class="instatic-nav-item__toggle" data-instatic-nav-item-toggle aria-expanded="false" aria-label="Toggle submenu">'
      + '<span class="instatic-nav-item__toggle-icon" aria-hidden="true">'
      + '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M6 9l6 6 6-6"/></svg>'
      + '</span></button>'
      + `<ul class="instatic-nav-item__submenu">${childHtml}</ul>`
      + '</li>',
    )
  })

  it('omits the caret/sub-menu entirely when childless', () => {
    const { html } = NavItemModule.render(baseProps as never, [])
    expect(html).not.toContain('data-instatic-nav-item-state')
    expect(html).not.toContain('data-instatic-nav-item-toggle')
    expect(html).not.toContain('instatic-nav-item__submenu')
  })

  it('prefixes every class it emits', () => {
    const { html, css } = NavItemModule.render(baseProps as never, [childHtml])
    const htmlClasses = Array.from(html.matchAll(/class="([^"]+)"/g)).flatMap((match) => match[1].split(' '))
    const cssClasses = Array.from(css!.matchAll(/\.([a-z][\w-]*)/g)).map((match) => match[1])
    for (const name of [...htmlClasses, ...cssClasses]) expect(name).toStartWith('instatic-nav-item')
  })

  it('collapses an unsafe href scheme to "#" via safeUrl', () => {
    const { html } = NavItemModule.render({ ...baseProps, href: 'javascript:alert(1)' } as never, [])
    expect(html).toContain('href="#"')
  })

  it('adds rel="noopener noreferrer" for target=_blank, omits rel for target=_self', () => {
    const blank = NavItemModule.render({ ...baseProps, target: '_blank' } as never, [])
    expect(blank.html).toContain('rel="noopener noreferrer"')

    const self = NavItemModule.render({ ...baseProps, target: '_self' } as never, [])
    expect(self.html).not.toContain('rel=')
  })

  it('renders htmlAttributes onto the <li> root, not the <a>', () => {
    const { html } = NavItemModule.render(
      { ...baseProps, htmlAttributes: { 'data-testid': 'nav-item-1' } } as never,
      [],
    )
    expect(html).toBe(
      '<li class="instatic-nav-item" data-testid="nav-item-1"><a class="instatic-nav-item__link" href="/about" target="_self">About</a></li>',
    )
  })

  it('keeps every media query out of the static css and ships a load-guarded JS runtime', () => {
    const { css, js } = NavItemModule.render(baseProps as never, [])
    expect(css).not.toContain('@media')
    expect(js).toContain('window.__instaticNavItemRuntimeLoaded')
  })

  it('shows the submenu caret at every width, beside the label', () => {
    const { css } = NavItemModule.render(baseProps as never, [])
    expect(css).toMatch(/\.instatic-nav-item__toggle \{\s+display: inline-flex;/)
    expect(navItemCollapseCss(768)).not.toContain('.instatic-nav-item__toggle {')
  })

  it('paints the desktop submenu from the menu background, with no hardcoded colour', () => {
    const { css } = NavItemModule.render(baseProps as never, [])
    expect(`${css}${navItemCollapseCss(768)}`).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    expect(css).toMatch(
      /\.instatic-nav-item > \.instatic-nav-item__submenu \{[^}]*background-color: var\(--instatic-nav-menu-bg, Canvas\);/,
    )
  })

  it('scopes its collapsed rules by the ancestor nav and its collapse width', () => {
    // base.nav-item's render() never sees its parent nav's props, so base.nav
    // emits this block for its own width.
    const css = navItemCollapseCss(913)
    expect(css).toContain('@media (max-width: 913px)')
    expect(css).toContain('.instatic-nav[data-instatic-nav-collapse="913"] .instatic-nav-item > .instatic-nav-item__submenu')
    // The submenu drops to its own row so the caret stays beside the label.
    expect(css).toContain('flex-wrap: wrap;')
    expect(css).toContain('flex-basis: 100%;')
  })

  it('indents each nested level of a collapsed menu on its links, one step deeper per submenu', () => {
    const css = navItemCollapseCss(913)
    const scope = '.instatic-nav[data-instatic-nav-collapse="913"]'
    const submenu = ' .instatic-nav-item__submenu'
    expect(NAV_ITEM_COLLAPSED_INDENTS).toEqual([28, 44, 60])
    expect(css).toContain(`${scope}${submenu} .instatic-nav-item__link {\n    padding-left: 28px;\n  }`)
    expect(css).toContain(`${scope}${submenu}${submenu} .instatic-nav-item__link {\n    padding-left: 44px;\n  }`)
    expect(css).toContain(`${scope}${submenu}${submenu}${submenu} .instatic-nav-item__link {\n    padding-left: 60px;\n  }`)
    // The indent is on the link. Padding the list would stop a nested row
    // from spanning the full menu width.
    expect(css).not.toMatch(/__submenu \{[^}]*padding-left/)
    // Deeper selectors come later, so a deeper level overrides a shallower one.
    expect(css.indexOf('padding-left: 28px')).toBeLessThan(css.indexOf('padding-left: 44px'))
    expect(css.indexOf('padding-left: 44px')).toBeLessThan(css.indexOf('padding-left: 60px'))
  })

  it('css and js are prop-independent (required by per-moduleId dedup, first-render-wins)', () => {
    const a = NavItemModule.render(baseProps as never, [])
    const b = NavItemModule.render({ ...baseProps, label: 'Different', href: '/x', isLink: false } as never, ['<li>x</li>'])
    expect(a.css).toBe(b.css)
    expect(a.js).toBe(b.js)
  })
})

describe('base.nav-item with the link turned off', () => {
  const unlinked = { ...baseProps, isLink: false }

  it('makes the label of an item with a submenu the toggle button itself', () => {
    const { html } = NavItemModule.render(unlinked as never, [childHtml])
    expect(html).not.toContain('<a ')
    expect(html).not.toContain('href=')
    expect(html).toContain(
      '<li class="instatic-nav-item" data-instatic-nav-item-state="closed">'
      + '<button type="button" class="instatic-nav-item__link" data-instatic-nav-item-toggle aria-expanded="false">About'
      + '<span class="instatic-nav-item__toggle-icon" aria-hidden="true">',
    )
    // One toggle, named by the label: no second caret button.
    expect(html.match(/data-instatic-nav-item-toggle/g)).toHaveLength(1)
    expect(html).not.toContain('aria-label="Toggle submenu"')
  })

  it('renders a childless unlinked item as plain text', () => {
    const { html } = NavItemModule.render(unlinked as never, [])
    expect(html).toBe('<li class="instatic-nav-item"><span class="instatic-nav-item__link">About</span></li>')
  })

  it('stays a link for a node stored before the prop existed', () => {
    const { isLink: _isLink, ...legacyProps } = baseProps
    const { html } = NavItemModule.render(legacyProps as never, [])
    expect(html).toContain('<a class="instatic-nav-item__link" href="/about"')
  })

  it('puts an "Enable link" toggle under the label, hiding Link and Target while it is off', () => {
    expect(Object.keys(NavItemModule.schema).slice(0, 4)).toEqual(['label', 'isLink', 'href', 'target'])
    expect(NavItemModule.schema.href).toEqual({ type: 'url', label: 'Link', condition: { field: 'isLink', notEq: false } })
    expect(NavItemModule.schema.isLink.type).toBe('toggle')
    expect(NavItemModule.schema.isLink.label).toBe('Enable link')
    expect(NavItemModule.defaults.isLink).toBe(true)
    expect(NavItemModule.schema.target.condition).toEqual({ field: 'isLink', notEq: false })
  })

  it('lets a toggle open its submenu at any width, not only when collapsed', () => {
    const { css } = NavItemModule.render(unlinked as never, [childHtml])
    expect(css).toContain(
      '.instatic-nav-item[data-instatic-nav-item-state="open"] > .instatic-nav-item__submenu {\n  display: flex;',
    )
  })
})

describe('base.nav-item runtime', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  function mountMenu() {
    const pricing = NavItemModule.render({ ...baseProps, label: 'Pricing', href: '/pricing' } as never, []).html
    const nested = NavItemModule.render({ ...baseProps, label: 'More', isLink: false } as never, [pricing]).html
    const products = NavItemModule.render({ ...baseProps, label: 'Products', isLink: false } as never, [nested]).html
    const company = NavItemModule.render({ ...baseProps, label: 'Company' } as never, [pricing]).html
    document.body.innerHTML = `<nav><ul>${products}${company}</ul></nav><p id="outside">Outside</p>`
    // The load guard makes a second evaluation a no-op, as on a real page.
    new Function(NAV_ITEM_RUNTIME_JS)()
    const [productsItem, moreItem] = Array.from(document.querySelectorAll<HTMLElement>('.instatic-nav-item'))
    const companyItem = document.querySelector<HTMLElement>('nav > ul > .instatic-nav-item:last-child')!
    const toggleOf = (item: HTMLElement) => item.querySelector<HTMLElement>(':scope > [data-instatic-nav-item-toggle]')!
    const stateOf = (item: HTMLElement) => item.getAttribute('data-instatic-nav-item-state')
    return { productsItem, moreItem, companyItem, toggleOf, stateOf }
  }

  it('toggles the submenu when an unlinked label is clicked, and mirrors it in aria-expanded', () => {
    const { productsItem, toggleOf, stateOf } = mountMenu()
    const label = toggleOf(productsItem)
    expect(label.tagName).toBe('BUTTON')
    expect(label.textContent).toBe('Products')

    label.click()
    expect(stateOf(productsItem)).toBe('open')
    expect(label.getAttribute('aria-expanded')).toBe('true')

    label.click()
    expect(stateOf(productsItem)).toBe('closed')
    expect(label.getAttribute('aria-expanded')).toBe('false')
  })

  it('toggles from the caret of a linked item, leaving the link itself alone', () => {
    const { companyItem, toggleOf, stateOf } = mountMenu()
    companyItem.querySelector<HTMLElement>(':scope > a')!.addEventListener('click', (event) => event.preventDefault())
    companyItem.querySelector<HTMLElement>(':scope > a')!.click()
    expect(stateOf(companyItem)).toBe('closed')

    toggleOf(companyItem).click()
    expect(stateOf(companyItem)).toBe('open')
  })

  it('keeps ancestors open when a nested toggle is clicked', () => {
    const { productsItem, moreItem, toggleOf, stateOf } = mountMenu()
    toggleOf(productsItem).click()
    toggleOf(moreItem).click()
    expect(stateOf(productsItem)).toBe('open')
    expect(stateOf(moreItem)).toBe('open')
    // aria-expanded stays on each item's own toggle.
    expect(toggleOf(productsItem).getAttribute('aria-expanded')).toBe('true')
  })

  it('closes an open item when a sibling toggle or anything outside it is clicked', () => {
    const { productsItem, companyItem, toggleOf, stateOf } = mountMenu()
    toggleOf(productsItem).click()
    toggleOf(companyItem).click()
    expect(stateOf(productsItem)).toBe('closed')
    expect(stateOf(companyItem)).toBe('open')

    document.getElementById('outside')!.click()
    expect(stateOf(companyItem)).toBe('closed')
    expect(toggleOf(companyItem).getAttribute('aria-expanded')).toBe('false')
  })

  it('closes every open item on Escape', () => {
    const { productsItem, moreItem, toggleOf, stateOf } = mountMenu()
    toggleOf(productsItem).click()
    toggleOf(moreItem).click()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(stateOf(productsItem)).toBe('closed')
    expect(stateOf(moreItem)).toBe('closed')
  })
})
