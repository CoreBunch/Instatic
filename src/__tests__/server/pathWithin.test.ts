import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { isPathWithin, assertPathWithin } from '../../../server/util/pathWithin'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/**
 * Path containment is decided by `relative()`, never by a string prefix.
 * Both prefix spellings are wrong in a different direction:
 *
 *   `startsWith(`${root}/`)`  — hard-codes a POSIX separator, so on Windows
 *                               (where `resolve` yields `\`) it rejects every
 *                               legitimate path. That was GHSA-hwp9: the
 *                               runtime package server 404'd all assets on
 *                               Windows hosts.
 *   `startsWith(root)`        — no separator at all, so a sibling directory
 *                               whose name merely begins with the root slips
 *                               through.
 */
describe('isPathWithin', () => {
  it('accepts a real descendant', () => {
    expect(isPathWithin('/srv/site', '/srv/site/build/app.js')).toBe(true)
    expect(isPathWithin('/srv/site', '/srv/site/a')).toBe(true)
  })

  it('rejects the root itself', () => {
    expect(isPathWithin('/srv/site', '/srv/site')).toBe(false)
  })

  it('rejects a traversal escape', () => {
    expect(isPathWithin('/srv/site', '/srv/site/../secrets')).toBe(false)
    expect(isPathWithin('/srv/site', '/srv')).toBe(false)
    expect(isPathWithin('/srv/site', '/etc/passwd')).toBe(false)
  })

  it('rejects a sibling that merely shares the root as a name prefix', () => {
    // The bare-`startsWith(root)` failure mode.
    expect(isPathWithin('/srv/site', '/srv/site-evil/app.js')).toBe(false)
    expect(isPathWithin('/srv/site', '/srv/sitedata')).toBe(false)
  })

  it('accepts a descendant whose name legitimately begins with dots', () => {
    // A naive `rel.startsWith('..')` would call this an escape.
    expect(isPathWithin('/srv/site', '/srv/site/..foo')).toBe(true)
    expect(isPathWithin('/srv/site', '/srv/site/...bar/baz')).toBe(true)
  })

  it('assertPathWithin throws exactly when isPathWithin is false', () => {
    expect(() => assertPathWithin('/srv/site', '/srv/site/ok')).not.toThrow()
    expect(() => assertPathWithin('/srv/site', '/srv/site-evil')).toThrow(/escapes root/)
    expect(() => assertPathWithin('/srv/site', '/srv/site')).toThrow(/escapes root/)
  })
})

describe('no separator-naive containment checks remain (GHSA-hwp9)', () => {
  const SINKS = [
    'server/publish/runtime/packageServer.ts',
    'server/publish/runtime/virtualSiteWorkspace.ts',
    'server/util/pathWithin.ts',
  ]

  it('containment sinks use the shared helper, not a string prefix', async () => {
    for (const relPath of SINKS) {
      const source = await readFile(join(ROOT, relPath), 'utf-8')
      const code = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '')
      // A containment decision written as `startsWith(`${someDir}/`)` or
      // `startsWith(someDir)` is the bug this suite exists to prevent.
      expect(code).not.toMatch(/startsWith\(\s*`\$\{\w*[Dd]ir\w*\}/)
      expect(code).not.toMatch(/startsWith\(\s*\w*(?:Dir|Root|rootDir)\w*\s*\)/)
    }
  })
})
