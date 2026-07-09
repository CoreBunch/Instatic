/**
 * Error-boundary coverage gate.
 *
 * The CMS uses a single `<ErrorBoundary>` primitive
 * (`src/ui/components/ErrorBoundary/`) at every architectural seam where a
 * render-time failure could blank a tree the user expects to be independent:
 *
 *   - admin-shell           — last-resort, full-page (src/admin/main.tsx)
 *   - admin-route           — per-section route wrapper (src/admin/router.tsx)
 *   - canvas                — editor canvas transform layer (CanvasRoot.tsx)
 *   - node-renderer         — per-module isolation in the canvas (NodeRenderer.tsx)
 *   - plugin-page           — third-party plugin admin page renderer
 *   - plugin-editor-panel   — third-party plugin editor sidebar panel
 *   - plugin-canvas-overlay — third-party plugin canvas overlay slot
 *
 * Plus the React 19 root-level error callbacks on the single `createRoot`
 * call in `src/admin/main.tsx`:
 *
 *   - onCaughtError, onUncaughtError, onRecoverableError
 *
 * If the boundary placements above drift (someone deletes a wrapper, renames
 * a location string, or removes a root callback), this gate fails CI loudly
 * with a single fix instruction.
 *
 * @see CLAUDE.md "Error handling" — boundary + tagged logging conventions
 */

import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const SRC_ROOT = join(import.meta.dir, '../..')

interface BoundaryPlacement {
  /** Path relative to src/ */
  file: string
  /** Required `location="..."` value */
  location: string
}

const REQUIRED_BOUNDARIES: BoundaryPlacement[] = [
  { file: 'admin/main.tsx', location: 'admin-shell' },
  { file: 'admin/router.tsx', location: 'admin-route' },
  { file: 'admin/pages/site/canvas/CanvasRoot.tsx', location: 'canvas' },
  { file: 'admin/pages/site/canvas/NodeRenderer.tsx', location: 'node-renderer' },
  {
    file: 'admin/pages/plugins/components/PluginPageRenderer/PluginPageRenderer.tsx',
    location: 'plugin-page',
  },
  {
    file: 'admin/pages/site/panels/PluginEditorPanel/PluginEditorPanel.tsx',
    location: 'plugin-editor-panel',
  },
  {
    file: 'admin/pages/site/canvas/PluginCanvasOverlayLayer/PluginCanvasOverlayLayer.tsx',
    location: 'plugin-canvas-overlay',
  },
]

const MAIN_FILE = join(SRC_ROOT, 'admin/main.tsx')

function read(rel: string): string {
  return readFileSync(join(SRC_ROOT, rel), 'utf8')
}

describe('Error boundary coverage gate', () => {
  it('every architectural seam imports and uses the shared ErrorBoundary primitive', () => {
    const failures: string[] = []
    for (const { file, location } of REQUIRED_BOUNDARIES) {
      let source: string
      try {
        source = read(file)
      } catch {
        failures.push(`MISSING FILE: ${file}`)
        continue
      }
      if (!/from\s+['"]@ui\/components\/ErrorBoundary['"]/.test(source)) {
        failures.push(`${file} — does not import ErrorBoundary from '@ui/components/ErrorBoundary'`)
      }
      if (!/<ErrorBoundary[\s>]/.test(source)) {
        failures.push(`${file} — does not render <ErrorBoundary />`)
      }
      // Match `location="<location>"` so the boundary tag stays unique and
      // the architecture stays explicit. Allow surrounding whitespace.
      const locationRe = new RegExp(`location\\s*=\\s*["']${location}["']`)
      if (!locationRe.test(source)) {
        failures.push(`${file} — missing required boundary location="${location}"`)
      }
    }

    if (failures.length > 0) {
      throw new Error(
        `[Error boundary coverage] missing or misconfigured boundaries:\n` +
          failures.map((f) => `  - ${f}`).join('\n') +
          `\n\nFix: ensure each seam uses <ErrorBoundary location="..."> from ` +
          `@ui/components/ErrorBoundary. See src/ui/components/ErrorBoundary/.`,
      )
    }
    expect(failures).toEqual([])
  })

  it('each boundary location string is used at exactly one seam (no duplicates)', () => {
    const seen = new Map<string, string>()
    const dupes: string[] = []
    for (const { file, location } of REQUIRED_BOUNDARIES) {
      const prior = seen.get(location)
      if (prior) {
        dupes.push(`location="${location}" used in both ${prior} and ${file}`)
      } else {
        seen.set(location, file)
      }
    }
    expect(dupes).toEqual([])
  })

  it('admin/main.tsx wires all three React 19 root error callbacks on createRoot', () => {
    const source = read('admin/main.tsx')
    const required = ['onCaughtError', 'onUncaughtError', 'onRecoverableError']
    const missing = required.filter((name) => !new RegExp(`${name}\\s*:`).test(source))
    if (missing.length > 0) {
      throw new Error(
        `[Error boundary coverage] admin/main.tsx is missing root createRoot ` +
          `callbacks: ${missing.join(', ')}. These are the single telemetry funnel ` +
          `for boundary-caught and uncaught render errors — keep all three wired.`,
      )
    }
    expect(missing).toEqual([])
  })

  it('admin/main.tsx mounts the single ToastProvider so boundaries can publish errors', () => {
    const source = read('admin/main.tsx')
    expect(source).toMatch(/from\s+['"]@ui\/components\/Toast['"]/)
    expect(source).toMatch(/<ToastProvider\s*\/>/)
  })

  it('the ErrorBoundary primitive lives in src/ui/components/ErrorBoundary/', () => {
    // If someone tries to fork the boundary (e.g. drop a copy in src/admin/pages/site/)
    // the architecture reviewer should catch it — but enforce the canonical
    // location explicitly.
    const indexSource = read('ui/components/ErrorBoundary/index.ts')
    expect(indexSource).toMatch(/export\s*\{\s*ErrorBoundary\s*\}/)
    const tsxSource = read('ui/components/ErrorBoundary/ErrorBoundary.tsx')
    expect(tsxSource).toMatch(/export\s+class\s+ErrorBoundary\s+extends\s+Component/)
  })

  it('main.tsx createRoot callbacks log via the shared logErrorChain helper', () => {
    // Catches the regression where someone replaces logErrorChain with a raw
    // `console.error(error)` and we lose the [<module>] prefix + cause chain.
    const source = read('admin/main.tsx')
    expect(source).toMatch(/logErrorChain/)
    expect(source).toMatch(/flattenErrorChain/)
  })
})
