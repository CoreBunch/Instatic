/**
 * Architecture gate: every host-side fetch of a PLUGIN-CONTROLLED URL goes
 * through `guardedFetch`.
 *
 * Storage-adapter plugins hand the host URLs to fetch — read URLs from
 * `publicPath` / `getReadUrl`, write URLs from the `beginWrite` upload plan.
 * Those URLs are validated for shape, never for target. A raw `fetch()` on any
 * of them turns the `media.storage.adapter` grant into `network.outbound`
 * reach it never asked for, and lets a plugin point the server at loopback,
 * private, link-local, or cloud-metadata addresses.
 *
 * This gate exists because that bug was fixed once and shipped incomplete:
 * GHSA-rmm7 closed the READ path in 0.0.18 and left the WRITE path open, which
 * came straight back as GHSA-9pq7. Fixing one call site is not fixing the
 * class. The rule is therefore file-scoped, not call-site-scoped: no bare
 * global `fetch(` anywhere under `server/handlers/cms/`.
 */

import { describe, expect, it } from 'bun:test'
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, dirname, relative } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const CMS_HANDLERS = join(ROOT, 'server', 'handlers', 'cms')

/**
 * Bare global `fetch(` — not `guardedFetch(`, not a method call such as
 * `source.fetch(` or `handler.fetch(`. The lookbehind rejects a preceding
 * word character (which excludes `guardedFetch`) or a dot (method calls).
 */
const BARE_FETCH = /(?<![.\w])fetch\s*\(/

/** Strip comments and string literals so prose and error text can't trip the scan. */
function stripNonCode(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
}

async function tsFilesIn(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true })
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.test.ts'))
    .map((e) => join(e.parentPath, e.name))
}

describe('plugin-controlled URL fetches are SSRF-guarded', () => {
  it('no CMS handler calls bare global fetch()', async () => {
    const offenders: string[] = []
    for (const file of await tsFilesIn(CMS_HANDLERS)) {
      const code = stripNonCode(await readFile(file, 'utf-8'))
      if (BARE_FETCH.test(code)) offenders.push(relative(ROOT, file))
    }
    expect(offenders).toEqual([])
  })

  it('the media read path fetches through guardedFetch', async () => {
    const source = await readFile(join(CMS_HANDLERS, 'mediaStorageReader.ts'), 'utf-8')
    expect(source).toMatch(/await\s+guardedFetch\(/)
  })

  it('the media write path fetches through guardedFetch', async () => {
    const source = await readFile(join(CMS_HANDLERS, 'mediaUploadExecutor.ts'), 'utf-8')
    expect(source).toMatch(/await\s+guardedFetch\(/)
    // The plan URL specifically — not some incidental guarded call elsewhere.
    expect(source).toMatch(/guardedFetch\(\s*step\.url/)
  })
})
