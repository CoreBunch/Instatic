/**
 * Architecture gate — every file under `server/handlers/cms/**.ts` must
 * call one of the auth helpers (`requireCapability`, `requireAnyCapability`,
 * `requireAuthenticatedUser`, `requireStepUp`) at least once.
 *
 * Mirrors `ai-handlers-capability-gated.test.ts` but for the CMS handler
 * tree. Catches the case where a new CMS endpoint ships completely
 * ungated — the previous lack of this gate is what let
 * `/admin/api/cms/dashboard/activity` leak audit data to any
 * authenticated user (A2 in the capabilities review).
 *
 * The `ALLOWLIST` covers files that are intentionally not gated by an
 * auth helper. Each entry needs a one-line justification.
 */

import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..', '..')
const CMS_HANDLERS_DIR = join(REPO_ROOT, 'server', 'handlers', 'cms')

const AUTH_GATE_RE = /\brequire(?:Capability|AnyCapability|AuthenticatedUser|StepUp)\s*\(/

/**
 * Files that intentionally do NOT call an auth helper. Each entry needs a
 * justification — adding a new entry means deliberately exposing a CMS
 * endpoint without an auth gate, which is rare enough that it should be
 * an explicit code-review decision.
 *
 * The allowlist key is the path RELATIVE TO `server/handlers/cms/` (e.g.
 * `setup.ts`, `plugins/state.ts`, `data/rows.ts`). Sub-handlers that are
 * reached only via a parent dispatcher which itself runs the gate are
 * allowlisted here with a "parent dispatcher gates" justification.
 */
const ALLOWLIST: ReadonlyMap<string, string> = new Map([
  // Public site identity + setup wizard live in this file. `setup` is a
  // one-shot bootstrap (409s after the first run); `public-site` exposes
  // only the two fields already rendered on every published page (site
  // name + favicon URL).
  ['setup.ts', 'Public bootstrap + site identity — gates aren\'t applicable.'],
  // Dispatcher / index — composes the per-resource handlers and runs
  // the CSRF Origin check. Per-handler files apply the actual auth gates.
  ['index.ts', 'Top-level dispatcher; per-handler files own the auth gates.'],
  // Shared route dispatcher — matches (method, path) → handler and owns the
  // one 404-vs-405 rule. Pure dispatch infra; the per-route handlers it
  // invokes own the actual auth/capability gates.
  ['routeTable.ts', 'Shared route dispatcher; per-route handlers own the auth gates.'],
  // Shared utilities — body parsers, audit context helpers, schema
  // exports. No request handlers live here.
  ['shared.ts', 'Shared request helpers; no handlers.'],
  ['session.ts', 'Session lookup helper; called from auth.ts which gates.'],
  ['siteDiff.ts', 'Diff validator called from site.ts after that file gates.'],
  // Media upload helpers — `acceptUploadedMedia`, `readUploadedFile`,
  // file-magic sniffing. Always called by an already-gated parent
  // handler (`/me/avatar`, `/media`).
  ['mediaUpload.ts', 'Multipart parse helper called by gated parent handlers.'],
  ['svgSanitize.ts', 'Pure SVG sanitiser called by mediaUpload (itself gated parents); no handlers.'],
  ['mediaUploadDispatch.ts', 'Storage adapter dispatch called by gated parent handlers.'],
  ['mediaUploadExecutor.ts', 'Filesystem write helper called by gated parent handlers.'],
  ['mediaVariants.ts', 'Variant generation helper called by gated parent handlers.'],
  ['mediaStorageReader.ts', 'Adapter read helper called by gated parent handlers.'],
  ['imageVariantProtocol.ts', 'Worker protocol type definitions; no handlers.'],
  ['imageVariantWorker.ts', 'Worker thread entrypoint; runs out-of-band, not a Bun.serve route.'],
  ['imageVariantWorkerHost.ts', 'Worker host helper; called by gated parent handlers.'],
  // Loop runtime — `/_instatic/loop/...` is a runtime endpoint for published
  // pages, not a CMS admin route. Reached only via the public router.
  ['loop.ts', 'Published-page runtime endpoint; not a /admin/api/cms/ route.'],
  ['hole.ts', 'Published-page runtime endpoint; not a /admin/api/cms/ route.'],
  // Module-JS assets — `/_instatic/module-js/<moduleId>.js` serves published
  // module runtimes to anonymous visitors, same trust model as hole/loop.
  ['moduleJs.ts', 'Published-page runtime endpoint; not a /admin/api/cms/ route.'],
  // Plugins sub-handlers — the dispatcher at plugins/index.ts resolves
  // capability + step-up via `resolvePluginRoutePolicy` and runs the gate
  // before delegating to any of these.
  ['plugins/state.ts', 'Parent dispatcher (plugins/index.ts) gates all routes here.'],
  ['plugins/schedules.ts', 'Parent dispatcher (plugins/index.ts) gates all routes here.'],
  ['plugins/install.ts', 'Parent dispatcher (plugins/index.ts) gates all routes here.'],
  ['plugins/settings.ts', 'Parent dispatcher (plugins/index.ts) gates all routes here.'],
  ['plugins/lifecycle.ts', 'Parent dispatcher (plugins/index.ts) gates all routes here.'],
  ['plugins/records.ts', 'Parent dispatcher (plugins/index.ts) gates all routes here.'],
  ['plugins/events.ts', 'Parent dispatcher (plugins/index.ts) gates all routes here.'],
  ['plugins/pack.ts', 'Parent dispatcher (plugins/index.ts) gates all routes here.'],
  ['plugins/shared.ts', 'Shared plugin helpers (payload builders, audit envelopes); no handlers.'],
  // Data sub-handlers — meta and search use the access helpers (which
  // wrap requireCapability inside data/access.ts); rows.ts and preview.ts
  // do too. The regex doesn't pick up the indirection through helpers,
  // but the gates are present.
  ['data/meta.ts', 'Uses requireDataAccess (access helper that wraps requireCapability).'],
  ['data/search.ts', 'Uses requireDataAccess (access helper that wraps requireCapability).'],
  ['data/rows.ts', 'Uses requireData* helpers from data/access.ts (which call requireCapability).'],
  ['data/preview.ts', 'Uses requireDataAccess helper that wraps requireCapability.'],
  ['data/schemas.ts', 'TypeBox schema definitions; no handlers.'],
  ['data/index.ts', 'Sub-dispatcher; delegates to per-resource handlers that gate.'],
  // Dashboard sub-handlers — the dispatcher at dashboard/index.ts maps each
  // widget segment to its reader + capability and runs the gate before
  // calling the reader. The per-widget files are pure data readers with no
  // request surface of their own.
  ['dashboard/index.ts', 'Dispatcher; per-widget capability gates run here before any reader.'],
  ['dashboard/types.ts', 'TypeScript response shape definitions; no handlers.'],
  ['dashboard/shared.ts', 'SQL + coercion helpers shared by widget readers; no handlers.'],
  ['dashboard/pages.ts', 'Widget data reader called by gated dashboard/index.ts dispatcher.'],
  ['dashboard/posts.ts', 'Widget data reader called by gated dashboard/index.ts dispatcher.'],
  ['dashboard/media.ts', 'Widget data reader called by gated dashboard/index.ts dispatcher.'],
  ['dashboard/plugins.ts', 'Widget data reader called by gated dashboard/index.ts dispatcher.'],
  ['dashboard/publishLineup.ts', 'Widget data reader called by gated dashboard/index.ts dispatcher.'],
  ['dashboard/activity.ts', 'Widget data reader called by gated dashboard/index.ts dispatcher.'],
  ['dashboard/storage.ts', 'Widget data reader called by gated dashboard/index.ts dispatcher.'],
])

function listHandlerFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const s = statSync(full)
    if (s.isDirectory()) {
      out.push(...listHandlerFiles(full))
    } else if (s.isFile() && extname(entry) === '.ts') {
      out.push(full)
    }
  }
  return out
}

describe('cms-handlers-capability-gated gate', () => {
  it('every CMS handler file calls requireCapability / requireAnyCapability / requireAuthenticatedUser / requireStepUp', () => {
    const files = listHandlerFiles(CMS_HANDLERS_DIR)
    expect(files.length).toBeGreaterThan(0)

    const violations: string[] = []
    for (const file of files) {
      // Build a path relative to the CMS handlers dir for ALLOWLIST lookup.
      // Keeps "plugins/state.ts" distinguishable from "state.ts" at root.
      const relKey = relative(CMS_HANDLERS_DIR, file).replaceAll('\\', '/')
      if (ALLOWLIST.has(relKey)) continue
      const src = readFileSync(file, 'utf8')
      if (!AUTH_GATE_RE.test(src)) {
        violations.push(relative(REPO_ROOT, file).replaceAll('\\', '/'))
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `[cms-handlers-capability-gated] handler files don't call any auth gate:\n` +
        violations.map((v) => `  ${v}`).join('\n') +
        `\n\nEvery /admin/api/cms/** route must gate access via ` +
        `requireCapability(), requireAnyCapability(), requireAuthenticatedUser(), ` +
        `or requireStepUp() so an unauthenticated caller cannot reach the CMS.\n` +
        `If the file is intentionally not gated (helper / dispatcher / shared ` +
        `module), add it to ALLOWLIST in this test with a justification.`,
      )
    }
    expect(violations).toHaveLength(0)
  })
})
