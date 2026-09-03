/**
 * Architecture gate: every public HTML render path goes through
 * `applyPublishedHtmlPipeline`.
 *
 * The dispatcher pipeline is the ONE place that:
 *   1. fires `publish.before` / `publish.after` events,
 *   2. runs `collectFrontendInjections` + `injectFrontendAssets` to splice
 *      every enabled plugin's declarative `frontend.assets[]`,
 *   3. runs the `publish.html` filter chain.
 *
 * Renderers (`renderPublishedSnapshot`, `renderPublishedDataRowTemplate`)
 * MUST NOT do any of that themselves — they return raw
 * `{ html, pageId, slug, siteId }` and the dispatcher pipes them through
 * the pipeline. That's how the analytics tracker ends up on posts the
 * same way it ends up on pages: identical post-processing for every
 * renderer's output.
 *
 * Two pins:
 *   A. The four primitives (`injectFrontendAssets`, `collectFrontendInjections`,
 *      `hookBus.applyFilter('publish.html', …)`, `hookBus.emit('publish.before|after', …)`)
 *      are imported in EXACTLY one server file: `publishedHtmlPipeline.ts`.
 *      (The frontend-injection helpers themselves still live in
 *      `frontendInjections.ts`; the preview iframe legitimately re-uses
 *      `collectFrontendInjections` + `injectFrontendAssets` because it
 *      renders into an iframe and intentionally SKIPS hook events.)
 *
 *   B. The dispatcher (`server/router.ts`) returns text/html responses
 *      only via `applyPublishedHtmlPipeline`. No public HTML path
 *      assembles its own HTML and bypasses the pipeline.
 *
 * If you add a new HTML-emitting code path, wire it through
 * `applyPublishedHtmlPipeline` — don't reimplement the pipeline.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '../../..')

/** Walk a tree, returning every `.ts` file path (skipping tests and dist). */
function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'dist' || name === 'node_modules' || name === '__tests__') continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) yield* walk(full)
    else if (name.endsWith('.ts')) yield full
  }
}

describe('dispatcher HTML pipeline', () => {
  it('the publish.* lifecycle bus is owned by exactly one server file', () => {
    // Files that legitimately call publish.before / publish.after / publish.html
    // on the hookBus. There must be exactly one — the dispatcher pipeline.
    const allowedOwners = new Set([
      'server/publish/publishedHtmlPipeline.ts',
    ])

    const violations: string[] = []
    for (const file of walk(join(ROOT, 'server'))) {
      const rel = file.slice(ROOT.length + 1)
      if (allowedOwners.has(rel)) continue
      const src = readFileSync(file, 'utf-8')
      // `hookBus.emit('publish.before'`, `hookBus.emit('publish.after'`,
      // `hookBus.applyFilter('publish.html'` — all three signal a code path
      // that's driving the publish lifecycle itself rather than using the
      // result. Only the dispatcher pipeline should do that.
      const drivesLifecycle =
        /hookBus\.emit\(\s*['"]publish\.(before|after)['"]/.test(src) ||
        /hookBus\.applyFilter\(\s*['"]publish\.html['"]/.test(src)
      if (drivesLifecycle) violations.push(rel)
    }
    if (violations.length > 0) {
      throw new Error(
        `publish.* lifecycle is driven outside the single pipeline owner:\n` +
        violations.map((v) => `  - ${v}`).join('\n') +
        `\nMove the calls into server/publish/publishedHtmlPipeline.ts and ` +
        `feed renderer output through applyPublishedHtmlPipeline(rendered, db).`,
      )
    }
    // Sanity: the owner file must actually exist.
    expect(() => readFileSync(join(ROOT, 'server/publish/publishedHtmlPipeline.ts'), 'utf-8')).not.toThrow()
  })

  it('the dispatcher emits public HTML only through applyPublishedHtmlPipeline', () => {
    // The dispatcher's public tail lives in publicRoutes.ts; published HTML
    // comes from publicRouter.ts (pages + posts), which owns the pipeline
    // call. A branch preview (renderBranchPreview) is the one other HTML
    // path there — a draft render that mirrors the editor's runtime preview
    // and deliberately fires no publish hooks.
    const router = readFileSync(join(ROOT, 'server/router.ts'), 'utf-8')
    const publicRoutes = readFileSync(join(ROOT, 'server/publish/publicRoutes.ts'), 'utf-8')
    const publicRouter = readFileSync(join(ROOT, 'server/publish/publicRouter.ts'), 'utf-8')

    expect(publicRoutes).toContain('renderPublicResolution')
    expect(publicRoutes).toContain('renderBranchPreview')
    expect(publicRouter).toContain('applyPublishedHtmlPipeline')

    // Sanity: no path calls the deprecated direct helpers.
    for (const src of [router, publicRoutes, publicRouter]) {
      expect(src).not.toContain('injectFrontendAssets(')
      expect(src).not.toContain("hookBus.applyFilter('publish.html'")
    }
  })

  it('the renderer output type stays raw (no injected HTML, no fired hooks)', () => {
    const src = readFileSync(join(ROOT, 'server/publish/publicRenderer.ts'), 'utf-8')

    // Renderer must not import the injection helpers — those live solely
    // in the dispatcher pipeline. (The preview iframe runtime is excluded
    // because it doesn't go through the public dispatcher.)
    expect(src).not.toContain("from './frontendInjections'")
    expect(src).not.toContain('hookBus')
    // Substring `publish.html` legitimately appears in comments — only the
    // actual filter / emit calls matter, and those would require the
    // hookBus import which we already prove absent above. The two
    // following patterns catch a sloppy author that imports hookBus from
    // elsewhere via destructuring.
    expect(src).not.toMatch(/applyFilter\(\s*['"]publish\.html['"]/)
    expect(src).not.toMatch(/emit\(\s*['"]publish\.(before|after)['"]/)
  })
})
