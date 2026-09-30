import { describe, expect, it } from 'bun:test'
import { generateClassCSS } from '@core/publisher'
import { classKindSelector, type StyleRule } from '@core/page-tree'
import { parseAnimationPreset } from '@core/animationPresets'
import { publishPage } from '@core/publisher'
import { makePage, makeSite, makeRegistry } from './helpers'

describe('entrance animation CSS', () => {
  const rule: StyleRule = {
    id: 'card', name: 'card', kind: 'class', selector: classKindSelector('card'), order: 0,
    styles: { animation: 'instatic-slide-up 600ms ease-out 200ms 1 both', transform: 'rotate(2deg)' },
    contextStyles: {}, createdAt: 0, updatedAt: 0,
  }

  it('publishes required keyframes alongside the class without unused presets', () => {
    const css = generateClassCSS({ card: rule }, [])
    expect(css).toContain('animation: instatic-slide-up 600ms ease-out 200ms 1 both;')
    expect(css).toContain('@keyframes instatic-slide-up')
    expect(css).toContain('translate: 0 24px;')
    expect(css).toContain('transform: rotate(2deg);')
    expect(css).not.toContain('@keyframes instatic-zoom-in')
  })

  it('reduced motion keeps content visible throughout the animation and delay', () => {
    const css = generateClassCSS({ card: rule }, [])
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(reduced).toContain('from { opacity: 1; translate: 0 0; }')
    expect(reduced).not.toContain('opacity: 0')
  })

  it('supports animations authored only at a breakpoint', () => {
    const css = generateClassCSS({ card: { ...rule, styles: {}, contextStyles: { mobile: rule.styles } } }, [{ id: 'mobile', width: 375 }])
    expect(css).toContain('@keyframes instatic-slide-up')
  })

  it('leaves custom animation values intact and does not add preset CSS', () => {
    const css = generateClassCSS({ card: { ...rule, styles: { animation: 'custom-spin 2s linear infinite' } } }, [])
    expect(css).toContain('custom-spin 2s linear infinite')
    expect(css).not.toContain('@keyframes')
    expect(parseAnimationPreset('custom-spin 2s linear infinite')).toBeNull()
  })

  it('round-trips the scroll trigger without defining hiding CSS keyframes', () => {
    const animation = 'instatic-slide-up-scroll 900ms ease-out 150ms 1 both'
    expect(parseAnimationPreset(animation)).toEqual({ name: 'instatic-slide-up', trigger: 'scroll', duration: 900, easing: 'ease-out', delay: 150 })
    const css = generateClassCSS({ card: { ...rule, styles: { animation } } }, [])
    expect(css).toContain(animation)
    expect(css).not.toContain('@keyframes')
  })

  it('includes the scroll runtime and self CSP only when scroll effects are configured', () => {
    const page = makePage({})
    const site = makeSite()
    const registry = makeRegistry({})
    const plain = publishPage(page, site, registry).html
    expect(plain).not.toContain('scroll-animation-runtime.js')
    site.styleRules = { card: { ...rule, styles: { animation: 'instatic-fade-in-scroll 600ms ease-out 0ms 1 both' } } }
    const html = publishPage(page, site, registry).html
    expect(html).toContain('src="/_instatic/scroll-animation-runtime.js"')
    expect(html).toContain("script-src 'self'")
  })
})
