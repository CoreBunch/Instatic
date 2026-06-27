import { describe, expect, test } from 'bun:test'
import { lintRobotsTxt, matchRobots } from '../robotsAnalysis'
import { generateRobotsTxt } from '../robots'

describe('lintRobotsTxt', () => {
  test('clean generated output has no findings', () => {
    const out = generateRobotsTxt({ sitemapEnabled: true, origin: 'https://acme.com' })
    expect(lintRobotsTxt(out)).toEqual([])
  })

  test('flags a rule before any User-agent', () => {
    const findings = lintRobotsTxt('Disallow: /private')
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ line: 1, level: 'error' })
  })

  test('flags unknown directives and bad values', () => {
    const text = 'User-agent: *\nDisalow: /typo\nSitemap: not-a-url\nCrawl-delay: soon'
    const findings = lintRobotsTxt(text)
    const messages = findings.map((f) => f.message).join(' | ')
    expect(messages).toContain('Unknown directive')
    expect(messages).toContain('absolute http(s) URL')
    expect(messages).toContain('not a number')
  })

  test('flags an empty User-agent and a non-directive line; ignores comments', () => {
    const findings = lintRobotsTxt('# a comment\nUser-agent:\njust some words')
    expect(findings.some((f) => f.message.includes('User-agent has no value'))).toBe(true)
    expect(findings.some((f) => f.message.includes('Not a "key: value"'))).toBe(true)
    expect(findings.every((f) => f.line !== 1)).toBe(true) // comment line ignored
  })
})

describe('matchRobots', () => {
  // The * group blocks /admin; Googlebot has its own group that allows
  // /admin/public and disallows /private.
  const robots = [
    'User-agent: *',
    'Allow: /',
    'Disallow: /admin',
    '',
    'User-agent: Googlebot',
    'Allow: /admin/public',
    'Disallow: /private',
    '',
    'Sitemap: https://acme.com/sitemap.xml',
  ].join('\n')

  test('default content path is allowed for everyone', () => {
    expect(matchRobots(robots, 'SomeBot', '/about').allowed).toBe(true)
  })

  test('system path is disallowed via the * group', () => {
    const m = matchRobots(robots, 'SomeBot', '/admin/settings')
    expect(m.allowed).toBe(false)
    expect(m.rule).toBe('Disallow: /admin')
  })

  test('a more specific user-agent group overrides the * group', () => {
    // Googlebot has its own group → the * group's /admin disallow does not apply.
    expect(matchRobots(robots, 'Googlebot', '/admin/settings').allowed).toBe(true)
    expect(matchRobots(robots, 'Googlebot', '/private/x').allowed).toBe(false)
  })

  test('longest match wins, Allow breaks ties', () => {
    // Googlebot: Allow /admin/public (its group has no /admin disallow, so
    // /admin/public is allowed by the explicit Allow).
    const m = matchRobots(robots, 'Googlebot', '/admin/public/doc')
    expect(m.allowed).toBe(true)
    expect(m.rule).toBe('Allow: /admin/public')
  })

  test('$ end-anchor and * wildcard are honored', () => {
    const text = 'User-agent: *\nDisallow: /*.pdf$\nDisallow: /search'
    expect(matchRobots(text, 'X', '/files/report.pdf').allowed).toBe(false)
    expect(matchRobots(text, 'X', '/files/report.pdf?v=1').allowed).toBe(true) // $ anchors the end
    expect(matchRobots(text, 'X', '/search/results').allowed).toBe(false)
  })
})
