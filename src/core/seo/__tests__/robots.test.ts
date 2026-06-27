import { describe, expect, test } from 'bun:test'
import { generateRobotsTxt, DEFAULT_ROBOTS_TEMPLATE, SYSTEM_DISALLOW_PATHS } from '../robots'

describe('generateRobotsTxt', () => {
  test('falls back to the default template and links the sitemap', () => {
    const out = generateRobotsTxt({ sitemapEnabled: true, origin: 'https://acme.com' })
    expect(out).toBe(`${DEFAULT_ROBOTS_TEMPLATE}\n\nSitemap: https://acme.com/sitemap.xml\n`)
    for (const path of SYSTEM_DISALLOW_PATHS) expect(out).toContain(`Disallow: ${path}`)
  })

  test('serves the stored content verbatim', () => {
    const content = 'User-agent: Googlebot\nDisallow: /private'
    const out = generateRobotsTxt({ robots: { content }, sitemapEnabled: false })
    expect(out).toBe(`${content}\n`)
  })

  test('omits the sitemap line without an origin or when disabled', () => {
    expect(generateRobotsTxt({ sitemapEnabled: true })).not.toContain('Sitemap:')
    expect(generateRobotsTxt({ sitemapEnabled: false, origin: 'https://a.com' })).not.toContain('Sitemap:')
  })

  test('does not append a sitemap line when the body already has one', () => {
    const content = 'User-agent: *\nAllow: /\nSitemap: https://acme.com/custom-sitemap.xml'
    const out = generateRobotsTxt({ robots: { content }, sitemapEnabled: true, origin: 'https://acme.com' })
    expect(out.match(/Sitemap:/g)).toHaveLength(1)
    expect(out).toContain('custom-sitemap.xml')
  })

  test('blockAll serves a bare Disallow with no sitemap', () => {
    const out = generateRobotsTxt({
      robots: { content: 'User-agent: *\nAllow: /' },
      sitemapEnabled: true,
      origin: 'https://acme.com',
      blockAll: true,
    })
    expect(out).toBe('User-agent: *\nDisallow: /\n')
  })

  test('empty/whitespace content falls back to the default template', () => {
    expect(generateRobotsTxt({ robots: { content: '   \n  ' }, sitemapEnabled: false })).toBe(
      `${DEFAULT_ROBOTS_TEMPLATE}\n`,
    )
  })
})
