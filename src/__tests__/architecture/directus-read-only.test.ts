/**
 * Architecture gate — the Directus reader is GET-only.
 *
 * A write helper or a POST/PATCH/PUT/DELETE route would turn this layer
 * into an open gateway against a content database. Live installations
 * use a reader token; the code must not be able to spend it on a write.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'fs'
import { extname, join } from 'path'

const REPO_ROOT = join(import.meta.dir, '../../../')

function collectTs(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const s = statSync(full)
    if (s.isDirectory()) out.push(...collectTs(full))
    else if (s.isFile() && extname(entry) === '.ts' && !entry.endsWith('.test.ts')) out.push(full)
  }
  return out
}

const WRITE_RE = /\b(POST|PATCH|PUT|DELETE)\b/
const METHOD_PARAM_RE = /method:\s*['"](?:POST|PATCH|PUT|DELETE)['"]/

describe('directus-read-only gate', () => {
  it('server/directus never issues a write', () => {
    const files = collectTs(join(REPO_ROOT, 'server/directus'))
    expect(files.length).toBeGreaterThan(0)
    const violations: string[] = []
    for (const file of files) {
      const src = readFileSync(file, 'utf8')
      if (METHOD_PARAM_RE.test(src) || /fetch\([^)]*\{\s*method:\s*['"]POST/.test(src)) {
        violations.push(file.slice(REPO_ROOT.length))
      }
    }
    expect(violations).toEqual([])
  })

  it('CMS Directus routes are GET-only', () => {
    const src = readFileSync(join(REPO_ROOT, 'server/handlers/cms/directus.ts'), 'utf8')
    expect(src).toContain("method: 'GET'")
    expect(WRITE_RE.test(src.replace(/GET/g, ''))).toBe(false)
    expect(src).not.toContain("method: 'POST'")
    expect(src).not.toContain("method: 'PATCH'")
    expect(src).not.toContain("method: 'PUT'")
    expect(src).not.toContain("method: 'DELETE'")
  })
})
