import { describe, expect, it } from 'bun:test'
import { NavModule } from '../index'

const baseProps = {
  ariaLabel: 'Primary navigation',
  toggleLabel: 'Menu',
  collapseBreakpoint: 768,
  collapsedStyle: 'dropdown' as const,
  menuBackground: '',
  toggleIcon: 'horizontal-lines' as const,
  toggleIconColor: '',
  menuAlign: 'start' as const,
  htmlAttributes: {},
}

describe('base.nav render', () => {
  it('renders the hamburger toggle + empty menu with zero children', () => {
    const { html } = NavModule.render(baseProps as never, [])
    expect(html).toBe(
      '<nav class="instatic-nav" data-instatic-nav data-instatic-nav-state="closed" data-instatic-nav-collapse="768" data-instatic-nav-mode="dropdown" data-instatic-nav-align="start" aria-label="Primary navigation">'
      + '<button type="button" class="instatic-nav__toggle" data-instatic-nav-toggle aria-expanded="false">'
      + '<span class="instatic-nav__toggle-icon" aria-hidden="true">'
      + '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M4 6h16M4 12h16M4 18h16"/></svg>'
      + '</span>'
      + '<span class="instatic-nav__toggle-label">Menu</span>'
      + '</button>'
      + '<ul class="instatic-nav__menu"></ul>'
      + '</nav>',
    )
  })

  it('joins renderedChildren verbatim inside the menu list', () => {
    const { html } = NavModule.render(baseProps as never, [
      '<li class="instatic-nav-item">A</li>',
      '<li class="instatic-nav-item">B</li>',
    ])
    expect(html).toContain('<ul class="instatic-nav__menu"><li class="instatic-nav-item">A</li><li class="instatic-nav-item">B</li></ul>')
  })

  it('omits aria-label entirely when empty', () => {
    const { html } = NavModule.render({ ...baseProps, ariaLabel: '' } as never, [])
    expect(html).not.toContain('aria-label')
  })

  it('renders htmlAttributes onto the <nav> root', () => {
    const { html } = NavModule.render(
      { ...baseProps, htmlAttributes: { 'data-testid': 'site-nav' } } as never,
      [],
    )
    expect(html).toContain('data-testid="site-nav"')
  })

  it('stamps the configured collapseBreakpoint and menuAlign as data attributes', () => {
    const { html } = NavModule.render({ ...baseProps, collapseBreakpoint: 1024, menuAlign: 'center' } as never, [])
    expect(html).toContain('data-instatic-nav-collapse="1024"')
    expect(html).toContain('data-instatic-nav-align="center"')
  })

  it('stamps the configured collapsedStyle as the nav mode', () => {
    const { html } = NavModule.render({ ...baseProps, collapsedStyle: 'overlay' } as never, [])
    expect(html).toContain('data-instatic-nav-mode="overlay"')
  })

  it('renders the configured toggle icon glyph', () => {
    const paths = {
      'horizontal-lines': 'M4 6h16M4 12h16M4 18h16',
      'vertical-lines': 'M6 4v16M12 4v16M18 4v16',
      chevron: 'M6 9l6 6 6-6',
      meatball: 'M5 12h.01M12 12h.01M19 12h.01',
    }
    for (const [toggleIcon, path] of Object.entries(paths)) {
      const { html } = NavModule.render({ ...baseProps, toggleIcon } as never, [])
      expect(html).toContain(`<path d="${path}"/>`)
    }
  })

  it('falls back to dropdown + horizontal lines for a node stored before those props existed', () => {
    const { collapsedStyle: _style, toggleIcon: _icon, ...legacyProps } = baseProps
    const { html } = NavModule.render(legacyProps as never, [])
    expect(html).toContain('data-instatic-nav-mode="dropdown"')
    expect(html).toContain('<path d="M4 6h16M4 12h16M4 18h16"/>')
  })

  it('offers every toggle icon in the picker with its glyph and name', () => {
    const control = NavModule.schema.toggleIcon
    if (control.type !== 'select') throw new Error('toggleIcon must be a select control')
    expect(control.options.map((option) => option.label)).toEqual([
      'Horizontal lines', 'Vertical lines', 'Chevron', 'Meatball',
    ])
    for (const option of control.options) expect(option.iconSvg).toContain('<svg')
  })

  it('lets the menu list fill the nav so menuAlign has free space to distribute', () => {
    const { css } = NavModule.render(baseProps as never, [])
    expect(css).toMatch(/\.instatic-nav__menu \{\s+flex: 1 1 auto;/)
    expect(css).toContain('[data-instatic-nav-align="end"] > .instatic-nav__menu {\n  justify-content: flex-end;')
  })

  it('keeps every media query out of the static css and ships a load-guarded JS runtime', () => {
    const { css, js } = NavModule.render(baseProps as never, [])
    expect(css).not.toContain('@media')
    expect(js).toContain('window.__instaticNavRuntimeLoaded')
  })

  it('emits the collapse rules for any typed width through instanceCss, for itself and nested Menu Items', () => {
    const { html, instanceCss } = NavModule.render({ ...baseProps, collapseBreakpoint: 913 } as never, [])
    expect(html).toContain('data-instatic-nav-collapse="913"')
    expect(instanceCss).toContain('@media (max-width: 913px)')
    expect(instanceCss).toContain('.instatic-nav[data-instatic-nav-collapse="913"][data-instatic-nav-mode="dropdown"] > .instatic-nav__menu')
    expect(instanceCss).toContain('.instatic-nav[data-instatic-nav-collapse="913"][data-instatic-nav-mode="overlay"] > .instatic-nav__menu')
    expect(instanceCss).toContain('.instatic-nav[data-instatic-nav-collapse="913"] .instatic-nav-item > .instatic-nav-item__submenu')
  })

  it('opens the collapsed menu from the state attribute the runtime sets, and locks page scroll under an open overlay', () => {
    const { instanceCss } = NavModule.render(baseProps as never, [])
    expect(instanceCss).toContain(
      '.instatic-nav[data-instatic-nav-collapse="768"][data-instatic-nav-state="open"] > .instatic-nav__menu {\n    display: flex;',
    )
    expect(instanceCss).toContain(
      'html:has(.instatic-nav[data-instatic-nav-collapse="768"][data-instatic-nav-mode="overlay"][data-instatic-nav-state="open"]) {\n    overflow: hidden;',
    )
  })

  it('accepts a width stored as a numeric string and falls back to 768 for junk', () => {
    expect(NavModule.render({ ...baseProps, collapseBreakpoint: '1024' } as never, []).html)
      .toContain('data-instatic-nav-collapse="1024"')
    expect(NavModule.render({ ...baseProps, collapseBreakpoint: 'wide' } as never, []).html)
      .toContain('data-instatic-nav-collapse="768"')
  })

  it('instanceCss depends on the collapse width alone', () => {
    const a = NavModule.render(baseProps as never, [])
    const b = NavModule.render(
      { ...baseProps, menuAlign: 'end', collapsedStyle: 'overlay', menuBackground: '#000000', toggleIcon: 'chevron' } as never,
      [],
    )
    expect(a.instanceCss).toBe(b.instanceCss)
  })

  it('offers collapse presets on a free-form number control', () => {
    const control = NavModule.schema.collapseBreakpoint
    if (control.type !== 'number') throw new Error('collapseBreakpoint must be a number control')
    expect(control.presets).toEqual([640, 768, 1024])
  })

  it('carries the menu background on the menu list in both collapsed styles, and nothing when empty', () => {
    for (const collapsedStyle of ['dropdown', 'overlay']) {
      const { html } = NavModule.render({ ...baseProps, collapsedStyle, menuBackground: '#112233' } as never, [])
      expect(html).toContain('<ul class="instatic-nav__menu" style="--instatic-nav-menu-bg:#112233">')
    }
    expect(NavModule.render(baseProps as never, []).html).toContain('<ul class="instatic-nav__menu">')
  })

  it('drops a menu background that carries extra declarations', () => {
    const { html } = NavModule.render(
      { ...baseProps, menuBackground: 'red;position:absolute' } as never,
      [],
    )
    expect(html).toContain('<ul class="instatic-nav__menu">')
  })

  it('paints its collapsed panels from the menu background, with no hardcoded colour', () => {
    const { css, instanceCss } = NavModule.render(baseProps as never, [])
    const sheet = `${css}${instanceCss}`
    expect(sheet).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    for (const mode of ['dropdown', 'overlay']) {
      const rule = new RegExp(
        `\\[data-instatic-nav-mode="${mode}"\\] > \\.instatic-nav__menu \\{[^}]*background-color: var\\(--instatic-nav-menu-bg, Canvas\\);`,
      )
      expect(sheet).toMatch(rule)
    }
  })

  it('colours the menu icon through the toggle button, and inherits when empty', () => {
    const coloured = NavModule.render({ ...baseProps, toggleIconColor: '#ff0000' } as never, [])
    expect(coloured.html).toContain('data-instatic-nav-toggle aria-expanded="false" style="color:#ff0000">')
    const inherited = NavModule.render(baseProps as never, [])
    expect(inherited.html).toContain('data-instatic-nav-toggle aria-expanded="false">')
  })

  it('css and js are prop-independent (required by per-moduleId dedup, first-render-wins) even across different collapseBreakpoint/menuAlign values', () => {
    const a = NavModule.render(baseProps as never, [])
    const b = NavModule.render(
      { ...baseProps, ariaLabel: 'Different', collapseBreakpoint: 1024, menuAlign: 'end', collapsedStyle: 'overlay', toggleIcon: 'chevron' } as never,
      ['<li>x</li>'],
    )
    expect(a.css).toBe(b.css)
    expect(a.js).toBe(b.js)
  })
})
