/**
 * htmlPagePlan — turn a single HTML file into a PagePlan.
 *
 * Steps:
 *   1. Parse the full HTML with DOMParser (browser/happy-dom) to extract
 *      `<title>` text, `<link rel="stylesheet">` hrefs from `<head>`, and
 *      executable `<script>` tags from the full document.
 *      In environments without DOMParser, falls back to a minimal regex
 *      scanner so the module stays headless.
 *   2. Resolve each stylesheet href relative to the HTML file's path, then
 *      look it up in the FileMap.  Missing hrefs → `missing-stylesheet` warning.
 *   3. Derive title (prefer `<title>` tag; fall back to prettified filename).
 *   4. Derive URL-safe slug from the filename.
 *   5. Call `importHtml(source)` to produce the body node fragment.
 */

import { dirname, joinPaths } from './paths'
import { importHtml } from '@core/htmlImport'
import { normalizePageSlug } from '@core/page-tree'
import type { FileMap, ImportWarning, PagePlan, PageScript } from './types'
import type { SiteScriptFormat } from '@core/site-runtime'

// ---------------------------------------------------------------------------
// Public function
// ---------------------------------------------------------------------------

interface HtmlPagePlanResult {
  pagePlan: PagePlan
  warnings: ImportWarning[]
  /**
   * Raw CSS harvested from `<style>` blocks in the HTML head/body. Empty when
   * the page had none. `buildImportPlan` parses this with the site's
   * breakpoints and folds the rules in as a synthetic per-page CSS source so
   * they scope, resolve assets, and detect conflicts like any linked stylesheet.
   */
  inlineCss: string
}

/**
 * Build a PagePlan for one HTML file.
 *
 * @param htmlPath   — FileMap key of the HTML file (e.g. `"pages/about.html"`).
 * @param htmlSource — Raw HTML string (decoded from FileMap bytes).
 * @param fileMap    — The full FileMap, used to resolve stylesheet hrefs.
 */
export function makeHtmlPagePlan(
  htmlPath: string,
  htmlSource: string,
  fileMap: FileMap,
): HtmlPagePlanResult {
  const warnings: ImportWarning[] = []

  // --- Step 1: extract <title>, stylesheet links, and script references ---
  const { title: extractedTitle, linkHrefs, scriptRefs } = extractDocumentMeta(htmlSource, htmlPath)

  // --- Step 2: resolve stylesheet hrefs to FileMap keys ---
  const linkedCssPaths: string[] = []
  for (const href of linkHrefs) {
    const resolved = resolveHref(href, htmlPath)
    if (resolved && fileMap.files[resolved]) {
      linkedCssPaths.push(resolved)
    } else if (resolved) {
      warnings.push({
        kind: 'missing-stylesheet',
        message: `Stylesheet "${href}" linked by "${htmlPath}" was not found in the import`,
        source: htmlPath,
        path: href,
      })
    }
    // href that couldn't be resolved (external, absolute, etc.) is silently ignored
  }

  const scripts: PageScript[] = []
  for (const script of scriptRefs) {
    if (script.kind === 'inline') {
      scripts.push(script)
      continue
    }
    const resolved = resolveHref(script.src, htmlPath)
    if (resolved && fileMap.files[resolved]) {
      scripts.push({ kind: 'external', path: resolved, format: script.format })
    } else if (resolved) {
      warnings.push({
        kind: 'missing-script',
        message: `Script "${script.src}" linked by "${htmlPath}" was not found in the import`,
        source: htmlPath,
        path: script.src,
      })
    }
  }

  // --- Step 3: derive title ---
  const title = extractedTitle && extractedTitle.length > 0
    ? extractedTitle
    : prettifyTitle(htmlPath)

  // --- Step 4: derive slug ---
  const slug = deriveSlug(htmlPath)

  // --- Step 5: parse body nodes (+ harvest inline styles and <style> CSS) ---
  const { styleCss, stripped: _stripped, ...nodeFragment } = importHtml(htmlSource)

  const pagePlan: PagePlan = {
    source: htmlPath,
    title,
    slug,
    linkedCssPaths,
    scripts,
    nodeFragment,
  }

  return { pagePlan, warnings, inlineCss: styleCss }
}

// ---------------------------------------------------------------------------
// Document metadata extraction
// ---------------------------------------------------------------------------

type ScriptRef =
  | {
    kind: 'external'
    src: string
    format: SiteScriptFormat
  }
  | {
    kind: 'inline'
    path: string
    content: string
    format: SiteScriptFormat
  }

interface DocumentMeta {
  title: string | null
  linkHrefs: string[]
  scriptRefs: ScriptRef[]
}

/**
 * Extract `<title>` text, `<link rel="stylesheet">` hrefs, and script refs
 * from HTML.
 *
 * Uses DOMParser when available (browser + happy-dom test environment).
 * Falls back to regex for server-side or other environments without a DOM.
 */
function extractDocumentMeta(htmlSource: string, htmlPath: string): DocumentMeta {
  // Try DOMParser (browser, happy-dom)
  if (typeof DOMParser !== 'undefined') {
    return extractDocumentMetaFromDom(htmlSource, htmlPath)
  }
  // Fallback: lightweight regex extraction
  return extractDocumentMetaFromRegex(htmlSource, htmlPath)
}

const CLASSIC_JAVASCRIPT_TYPES = new Set([
  'application/ecmascript',
  'application/javascript',
  'application/x-ecmascript',
  'application/x-javascript',
  'text/ecmascript',
  'text/javascript',
  'text/javascript1.0',
  'text/javascript1.1',
  'text/javascript1.2',
  'text/javascript1.3',
  'text/javascript1.4',
  'text/javascript1.5',
  'text/jscript',
  'text/livescript',
  'text/x-ecmascript',
  'text/x-javascript',
])

function scriptFormatFromType(type: string | null): SiteScriptFormat | null {
  const normalized = type?.trim().toLowerCase().split(';', 1)[0] ?? ''
  if (normalized === '' || CLASSIC_JAVASCRIPT_TYPES.has(normalized)) return 'classic'
  if (normalized === 'module') return 'module'
  return null
}

function extractDocumentMetaFromDom(htmlSource: string, htmlPath: string): DocumentMeta {
  try {
    const doc = new DOMParser().parseFromString(htmlSource, 'text/html')
    const titleEl = doc.querySelector('title')
    const title = titleEl?.textContent?.trim() ?? null

    const linkHrefs: string[] = []
    const links = doc.querySelectorAll('link[rel="stylesheet"]')
    for (const link of Array.from(links)) {
      const href = link.getAttribute('href')
      if (href && href.trim().length > 0) linkHrefs.push(href.trim())
    }

    const scriptRefs: ScriptRef[] = []
    const scripts = doc.querySelectorAll('script')
    let inlineIndex = 0
    for (const script of Array.from(scripts)) {
      const format = scriptFormatFromType(script.getAttribute('type'))
      if (!format) continue

      const src = script.getAttribute('src')
      if (src && src.trim().length > 0) {
        scriptRefs.push({ kind: 'external', src: src.trim(), format })
        continue
      }

      const content = script.textContent?.trim() ?? ''
      if (content.length === 0) continue
      inlineIndex += 1
      scriptRefs.push({
        kind: 'inline',
        path: inlineScriptPath(htmlPath, inlineIndex),
        content,
        format,
      })
    }

    return { title, linkHrefs, scriptRefs }
  } catch {
    // DOM parse failed — fall through to regex
    return extractDocumentMetaFromRegex(htmlSource, htmlPath)
  }
}

/** Minimal regex fallback for environments without DOMParser. */
function extractDocumentMetaFromRegex(htmlSource: string, htmlPath: string): DocumentMeta {
  // Extract <title>
  const titleMatch = htmlSource.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const title = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : null

  // Extract <link rel="stylesheet" href="...">
  // Handles both attr orders and single/double quotes
  const linkHrefs: string[] = []
  const linkRe = /<link\s[^>]*>/gi
  let linkMatch: RegExpExecArray | null
  while ((linkMatch = linkRe.exec(htmlSource)) !== null) {
    const tag = linkMatch[0]
    const hasStylesheet = /rel=["']stylesheet["']/i.test(tag)
    if (hasStylesheet) {
      const hrefMatch = tag.match(/href=["']([^"']+)["']/i)
      if (hrefMatch) linkHrefs.push(hrefMatch[1].trim())
    }
  }

  const scriptRefs: ScriptRef[] = []
  // Close tag matches `</script>`, `</script >`, and `</script foo>` — the HTML
  // parser ends the tag at the first `>` (CodeQL js/bad-tag-filter).
  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script(?:[\s/][^>]*)?>/gi
  let scriptMatch: RegExpExecArray | null
  let inlineIndex = 0
  while ((scriptMatch = scriptRe.exec(htmlSource)) !== null) {
    const attrs = scriptMatch[1] ?? ''
    const format = scriptFormatFromType(attrValue(attrs, 'type'))
    if (!format) continue

    const src = attrValue(attrs, 'src')?.trim()
    if (src) {
      scriptRefs.push({ kind: 'external', src, format })
      continue
    }

    const content = (scriptMatch[2] ?? '').trim()
    if (content.length === 0) continue
    inlineIndex += 1
    scriptRefs.push({
      kind: 'inline',
      path: inlineScriptPath(htmlPath, inlineIndex),
      content,
      format,
    })
  }

  return { title, linkHrefs, scriptRefs }
}

function inlineScriptPath(htmlPath: string, index: number): string {
  return `${htmlPath}-inline-script-${index}.js`
}

function attrValue(attrs: string, name: string): string | null {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`, 'i')
  const match = attrs.match(re)
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a stylesheet href relative to the HTML file's path in the FileMap.
 *
 * Returns a normalized FileMap key, or null when the href is external,
 * a fragment, a data URL, or cannot be resolved to a safe relative path.
 */
export function resolveHref(href: string, htmlFilePath: string): string | null {
  // Skip external, protocol-relative, data, fragment, mailto, tel
  if (/^https?:\/\/|^\/\/|^data:|^mailto:|^tel:|^#/.test(href)) return null

  const normalized = href.startsWith('/')
    ? href.slice(1) // root-relative: strip leading /
    : joinPaths(dirname(htmlFilePath), href)

  // Must not escape to a parent-of-root path
  if (!normalized || normalized.startsWith('../') || normalized.includes('/../')) return null

  return normalized
}


// ---------------------------------------------------------------------------
// Slug and title derivation
// ---------------------------------------------------------------------------

/**
 * Derive a URL-safe slug from an HTML file path.
 *
 * Rules:
 *   - Strip the extension from the HTML file path.
 *   - Preserve safe nested path segments (`docs/api.html` → `docs/api`).
 *   - Treat nested `index.html` as the directory route
 *     (`docs/index.html` → `docs`), while root `index.html` stays `index`.
 *   - Lowercase and sanitise each segment with page-slug rules.
 *   - If the result is empty, fall back to `'page'`.
 */
export function deriveSlug(htmlPath: string): string {
  const pathWithoutExtension = htmlPath
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.[^/.]+$/, '')
  const rawSegments = pathWithoutExtension.split('/').filter(Boolean)
  const lastIndex = rawSegments.length - 1
  const slugSegments = rawSegments.flatMap((segment, index) => {
    const normalized = normalizePageSlug(segment)
    if (normalized) return [normalized]
    return index === lastIndex ? ['page'] : []
  })

  if (slugSegments.length > 1 && slugSegments[slugSegments.length - 1] === 'index') {
    slugSegments.pop()
  }

  return slugSegments.join('/') || 'page'
}

/**
 * Prettify a filename into a display title.
 *
 * E.g. `"pages/hero-lab.html"` → `"Hero Lab"`,
 *      `"about_us.html"` → `"About Us"`.
 */
export function prettifyTitle(htmlPath: string): string {
  const basename = htmlPath.split('/').pop() ?? htmlPath
  const name = basename.replace(/\.[^.]+$/, '')
  return name
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim() || 'Untitled'
}
