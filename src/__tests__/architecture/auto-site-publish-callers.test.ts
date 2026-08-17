/**
 * Architecture Source-Scan — who may ask for an automatic site republish.
 *
 * `requestAutoSitePublish` (`server/publish/autoSitePublish.ts`) runs a full
 * site publish. Two rules keep that safe, and both are structural rather than
 * enforceable at runtime — which is why they are pinned here.
 *
 * 1. **The publish pipeline must never call it.** A site publish that could ask
 *    for a site publish is a loop. Nothing under `server/publish/` may call the
 *    trigger except the module that defines it and the scheduled-publish tick,
 *    which fires per row and is not part of a running publish. A runtime origin
 *    check cannot replace this gate: plugin `publish.before` / `publish.html` /
 *    `publish.after` handlers run in the QuickJS worker and their RPCs return on
 *    their own event-loop task, so an async-context flag would report "not
 *    inside a publish" for the one caller that could actually recurse.
 *
 * 2. **The callers are the ones that change public visibility.** Publishing an
 *    entry, retracting one, and deleting one change what a listing should show;
 *    saving a draft or reassigning an author do not. Keeping the caller set
 *    small and named is what stops a full site publish being attached to an
 *    ordinary keystroke-rate save.
 *
 * Adding a caller is allowed — add it to `ALLOWED_CALLERS` with a line saying
 * which visibility change it represents.
 */

import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative } from 'node:path'

const PROJECT_ROOT = join(import.meta.dir, '../../../')
const SERVER_ROOT = join(PROJECT_ROOT, 'server')

/** The module that defines the trigger — it names the symbol by definition. */
const DEFINING_MODULE = 'server/publish/autoSitePublish.ts'

/** Every file allowed to ask for an automatic republish, and why. */
const ALLOWED_CALLERS = new Map<string, string>([
  [
    'server/handlers/cms/data/rows.ts',
    'publish / unpublish / delete of one entry — the three admin routes that change public visibility',
  ],
  [
    'server/publish/publishScheduler.ts',
    'a scheduled entry going live with nobody watching',
  ],
])

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (extname(entry) === '.ts') out.push(full)
  }
  return out
}

describe('auto-site-publish callers', () => {
  const serverFiles = walk(SERVER_ROOT)

  test('the server tree was actually scanned', () => {
    // A gate that silently inspects zero files passes forever.
    expect(serverFiles.length).toBeGreaterThan(100)
  })

  test('only the named visibility-change call sites request a republish', () => {
    const offenders: string[] = []
    for (const file of serverFiles) {
      const rel = relative(PROJECT_ROOT, file)
      if (rel === DEFINING_MODULE || ALLOWED_CALLERS.has(rel)) continue
      if (readFileSync(file, 'utf-8').includes('requestAutoSitePublish')) offenders.push(rel)
    }
    expect(offenders).toEqual([])
  })

  test('every allowed caller still calls it', () => {
    // Keeps the allowlist honest: a caller that was removed must be removed
    // here too, so the list never grows into a set of stale permissions.
    for (const [rel] of ALLOWED_CALLERS) {
      const src = readFileSync(join(PROJECT_ROOT, rel), 'utf-8')
      expect(`${rel}: ${src.includes('requestAutoSitePublish(')}`).toBe(`${rel}: true`)
    }
  })

  test('the full-site publish orchestrator does not import the trigger', () => {
    // The narrowest statement of "a site publish cannot start a site publish".
    // Matched on the import specifier, so the module may still be NAMED in the
    // orchestrator's prose — the two modules explain each other.
    const src = readFileSync(join(PROJECT_ROOT, 'server/publish/publishSite.ts'), 'utf-8')
    expect(src).not.toMatch(/from '\.\/autoSitePublish'/)
  })
})
