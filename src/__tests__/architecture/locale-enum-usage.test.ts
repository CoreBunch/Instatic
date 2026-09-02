/**
 * Architecture gate — locales are a closed enum.
 *
 * Every language / locale the product handles must be one of the 8 BCP 47
 * tags the Directus API client supports. The catalog lives once, in
 * `src/core/locales.ts` (`SUPPORTED_LOCALES` / `SupportedLocaleSchema`), and
 * feeds the Directus reader, its MCP tool enums, and every locale picker or
 * `ogLocale` field that lands after it. This gate stops a new surface from
 * re-opening the field to any string.
 *
 * Assertions:
 *   1. The catalog is exactly the 8 Directus locales.
 *   2. No TypeBox schema under `src/` or `server/` types a `locale` /
 *      `ogLocale` property as `Type.String` — it must use the enum.
 *   3. No type or interface under `src/core/` or `server/` declares a
 *      `locale` / `ogLocale` member as `string` — it must be `SupportedLocale`.
 *   4. No file other than the catalog builds locale names from `Intl.DisplayNames`.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'fs'
import { extname, join, relative } from 'path'
import { SUPPORTED_LOCALES } from '@core/locales'

const REPO_ROOT = join(import.meta.dir, '../../../')
const CATALOG = 'src/core/locales.ts'

function collectSources(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__') continue
    const full = join(dir, entry)
    const s = statSync(full)
    if (s.isDirectory()) out.push(...collectSources(full))
    else if (
      s.isFile() &&
      ['.ts', '.tsx'].includes(extname(entry)) &&
      !entry.endsWith('.test.ts') &&
      !entry.endsWith('.test.tsx')
    ) {
      out.push(full)
    }
  }
  return out
}

function rel(file: string): string {
  return relative(REPO_ROOT, file)
}

function violations(files: string[], pattern: RegExp): string[] {
  const out: string[] = []
  for (const file of files) {
    const path = rel(file)
    if (path === CATALOG) continue
    const src = readFileSync(file, 'utf8')
    src.split('\n').forEach((line, index) => {
      if (pattern.test(line)) out.push(`${path}:${index + 1}: ${line.trim()}`)
    })
  }
  return out
}

/** `locale: Type.String(` / `ogLocale: Type.Optional(Type.String(` — a schema that accepts any tag. */
const SCHEMA_STRING_LOCALE_RE = /\b(?:og)?[lL]ocale\??\s*:\s*Type\.(?:Optional\(\s*)?Type\.String\b/

/** `locale?: string` / `ogLocale: string` in a type, interface, or signature. */
const TYPE_STRING_LOCALE_RE = /\b(?:og)?[lL]ocale\??\s*:\s*string\b/

describe('locale enum gate', () => {
  it('the catalog is exactly the 8 Directus locales', () => {
    expect([...SUPPORTED_LOCALES]).toEqual([
      'fr-BE', 'nl-BE', 'de-BE', 'en-BE', 'fr-FR', 'en-FR', 'nl-NL', 'en-NL',
    ])
  })

  it('no TypeBox schema types a locale as a free string', () => {
    const files = [...collectSources(join(REPO_ROOT, 'src')), ...collectSources(join(REPO_ROOT, 'server'))]
    expect(violations(files, SCHEMA_STRING_LOCALE_RE)).toEqual([])
  })

  it('no engine or server type declares a locale as a free string', () => {
    const files = [...collectSources(join(REPO_ROOT, 'src/core')), ...collectSources(join(REPO_ROOT, 'server'))]
    expect(violations(files, TYPE_STRING_LOCALE_RE)).toEqual([])
  })

  it('only the catalog derives locale display names', () => {
    const files = [...collectSources(join(REPO_ROOT, 'src')), ...collectSources(join(REPO_ROOT, 'server'))]
    expect(violations(files, /Intl\.DisplayNames\([^)]*type:\s*['"]language['"]/)).toEqual([])
  })
})
