/**
 * robots.txt analysis — pure helpers the admin Robots.txt tab uses to lint
 * the generated file and test a URL against it. Both operate on the SAME
 * text the endpoint serves (via `generateRobotsTxt`), so the tab's feedback
 * always reflects exactly what crawlers receive.
 *
 *   - `lintRobotsTxt` flags syntax problems crawlers would ignore silently
 *     (unknown directives, rules before any `User-agent`, malformed values).
 *   - `matchRobots` answers "is this path allowed for this crawler?" using
 *     Google's longest-match semantics (most-specific rule wins, `Allow`
 *     breaks ties) with `*` wildcard and `$` end-anchor support.
 */

// ---------------------------------------------------------------------------
// Lint
// ---------------------------------------------------------------------------

export type RobotsLintLevel = 'warning' | 'error'

export interface RobotsLintFinding {
  /** 1-based line number in the linted text. */
  line: number
  level: RobotsLintLevel
  message: string
}

const KNOWN_DIRECTIVES = new Set([
  'user-agent',
  'allow',
  'disallow',
  'sitemap',
  'crawl-delay',
  'host',
  'clean-param',
])

/** Directives that belong to a `User-agent` group (vs file-global ones). */
const GROUP_DIRECTIVES = new Set(['allow', 'disallow', 'crawl-delay'])

export function lintRobotsTxt(text: string): RobotsLintFinding[] {
  const findings: RobotsLintFinding[] = []
  let sawUserAgent = false

  text.split('\n').forEach((raw, index) => {
    const line = index + 1
    const stripped = raw.replace(/#.*$/, '').trim()
    if (stripped === '') return

    const colon = stripped.indexOf(':')
    if (colon === -1) {
      findings.push({ line, level: 'error', message: `Not a "key: value" directive: "${stripped}"` })
      return
    }

    const key = stripped.slice(0, colon).trim().toLowerCase()
    const value = stripped.slice(colon + 1).trim()

    if (!KNOWN_DIRECTIVES.has(key)) {
      findings.push({ line, level: 'warning', message: `Unknown directive "${stripped.slice(0, colon).trim()}" — crawlers will ignore it` })
      return
    }

    if (key === 'user-agent') {
      sawUserAgent = true
      if (value === '') findings.push({ line, level: 'error', message: 'User-agent has no value' })
      return
    }

    if (GROUP_DIRECTIVES.has(key) && !sawUserAgent) {
      findings.push({ line, level: 'error', message: `"${key}" appears before any "User-agent" group` })
    }

    if (key === 'crawl-delay' && value !== '' && Number.isNaN(Number(value))) {
      findings.push({ line, level: 'warning', message: `Crawl-delay "${value}" is not a number` })
    }

    if (key === 'sitemap' && !/^https?:\/\//i.test(value)) {
      findings.push({ line, level: 'warning', message: 'Sitemap should be an absolute http(s) URL' })
    }
  })

  return findings
}

// ---------------------------------------------------------------------------
// URL matcher
// ---------------------------------------------------------------------------

interface ParsedRule {
  type: 'allow' | 'disallow'
  path: string
}

interface ParsedGroup {
  agents: string[]
  rules: ParsedRule[]
}

/** Parse robots text into user-agent groups, collapsing consecutive headers. */
function parseGroups(text: string): ParsedGroup[] {
  const groups: ParsedGroup[] = []
  let current: ParsedGroup | null = null
  let expectingAgents = false

  for (const raw of text.split('\n')) {
    const stripped = raw.replace(/#.*$/, '').trim()
    if (stripped === '') continue
    const colon = stripped.indexOf(':')
    if (colon === -1) continue
    const key = stripped.slice(0, colon).trim().toLowerCase()
    const value = stripped.slice(colon + 1).trim()

    if (key === 'user-agent') {
      // Consecutive User-agent lines share the following rule block.
      if (!current || !expectingAgents) {
        current = { agents: [], rules: [] }
        groups.push(current)
        expectingAgents = true
      }
      current.agents.push(value.toLowerCase())
    } else if (key === 'allow' || key === 'disallow') {
      if (!current) continue
      expectingAgents = false
      current.rules.push({ type: key, path: value })
    }
  }

  return groups
}

/** Translate a robots path pattern (`*` wildcard, `$` end-anchor) to RegExp. */
function patternToRegExp(pattern: string): RegExp {
  let source = ''
  for (const char of pattern) {
    if (char === '*') source += '.*'
    else if (char === '$') source += '$'
    else source += char.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source}`)
}

/** Effective path length a pattern matches against, for longest-match wins. */
function matchLength(pattern: string, path: string): number | null {
  if (pattern === '') return null
  if (patternToRegExp(pattern).test(path)) {
    // Specificity ≈ pattern length excluding wildcards (Google's rule).
    return pattern.replace(/\*/g, '').length
  }
  return null
}

export interface RobotsMatch {
  allowed: boolean
  /** The winning rule, e.g. `Disallow: /admin`; absent ⇒ no rule applied. */
  rule: string | null
}

/**
 * Decide whether `path` is crawlable by `userAgent` per `robotsText`. Picks
 * the most specific matching user-agent group (exact token, else `*`), then
 * the longest matching Allow/Disallow within it (Allow wins ties). No
 * matching rule ⇒ allowed.
 */
export function matchRobots(robotsText: string, userAgent: string, path: string): RobotsMatch {
  const groups = parseGroups(robotsText)
  const ua = userAgent.trim().toLowerCase()

  // Prefer a group naming this agent; fall back to the `*` group.
  const specific = groups.find((group) => group.agents.includes(ua))
  const wildcard = groups.find((group) => group.agents.includes('*'))
  const group = specific ?? wildcard
  if (!group) return { allowed: true, rule: null }

  let best: { type: 'allow' | 'disallow'; path: string; length: number } | null = null
  for (const rule of group.rules) {
    const length = matchLength(rule.path, path)
    if (length === null) continue
    // Longer match wins; on a tie, Allow beats Disallow.
    if (
      best === null ||
      length > best.length ||
      (length === best.length && rule.type === 'allow' && best.type === 'disallow')
    ) {
      best = { type: rule.type, path: rule.path, length }
    }
  }

  if (!best) return { allowed: true, rule: null }
  return {
    allowed: best.type === 'allow',
    rule: `${best.type === 'allow' ? 'Allow' : 'Disallow'}: ${best.path}`,
  }
}
