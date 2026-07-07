/**
 * Shared test helpers for the instatic test suite.
 *
 * Exports:
 *   - renderModule()              — safe wrapper around ModuleDefinition.render()
 *   - withBannedGlobals()         — detects forbidden global access in render()
 *   - runModuleConformanceSuite() — registers full contract tests for any ModuleDefinition
 */

import { describe, it, expect } from 'bun:test'
import type { AnyModuleDefinition, PropertyControl } from '@core/module-engine'

// ---------------------------------------------------------------------------
// renderModule
// ---------------------------------------------------------------------------

/**
 * Call def.render() with safe defaults merged with provided props.
 * Prevents "prop is undefined" crashes in tests — merges def.defaults first.
 *
 * NOTE: This helper calls render() directly WITHOUT applying escapeProps().
 * When testing real base modules for XSS safety, use the publisher pipeline:
 *   const safe = escapeProps({ ...mod.defaults, ...props })
 *   const { html } = mod.render(safe, [])
 * See base-modules.test.ts for the correct pattern.
 *
 * This helper is kept without escapeProps so tests can choose whether they are
 * exercising raw render() behavior or the publisher escape pipeline.
 *
 * @example
 * const { html } = renderModule(headingModule, { text: 'Hello' })
 * expect(html).toContain('Hello')
 */
export function renderModule(
  def: AnyModuleDefinition,
  props: Record<string, unknown> = {},
  renderedChildren: string[] = []
) {
  if (!def.render) throw new Error(`[test] Module "${def.id}" has no render() — use htmlContract tests instead`)
  return def.render({ ...def.defaults, ...props }, renderedChildren)
}

// ---------------------------------------------------------------------------
// withBannedGlobals — detect forbidden global access inside render()
// ---------------------------------------------------------------------------

/**
 * Globals that render() must NEVER access (Constraint #179: render must be pure).
 * Each is replaced with a throwing Proxy for the duration of the callback.
 */
const BANNED_IN_RENDER = ['document', 'fetch', 'eval'] as const
type BannedGlobal = (typeof BANNED_IN_RENDER)[number]

function makeBannedProxy(globalName: string): object {
  return new Proxy(
    function () {} as object,
    {
      get(_target, prop) {
        throw new Error(
          `[Constraint #179] render() accessed banned global ` +
            `"${globalName}.${String(prop)}" — render() must be a pure function.`
        )
      },
      apply(_target, _thisArg, _args) {
        throw new Error(
          `[Constraint #179] render() called banned global "${globalName}" — ` +
            `render() must be a pure function.`
        )
      },
      construct(_target, _args) {
        throw new Error(
          `[Constraint #179] render() constructed banned global "${globalName}" — ` +
            `render() must be a pure function.`
        )
      },
    }
  )
}

/**
 * Run `fn` with `document`, `fetch`, and `eval` replaced by throwing Proxies.
 * Any access to these globals inside `fn` will throw, causing the test to fail.
 *
 * Use inside an `it()` to assert render() doesn't access DOM globals:
 * @example
 * it('render() does not access document', () => {
 *   expect(() => withBannedGlobals(() => mod.render(mod.defaults, []))).not.toThrow()
 * })
 */
export function withBannedGlobals<T>(fn: () => T): T {
  const saved: Partial<Record<BannedGlobal, unknown>> = {}

  for (const g of BANNED_IN_RENDER) {
    saved[g] = (globalThis as Record<string, unknown>)[g]
    ;(globalThis as Record<string, unknown>)[g] = makeBannedProxy(g)
  }

  try {
    return fn()
  } finally {
    for (const g of BANNED_IN_RENDER) {
      const original = saved[g]
      if (original === undefined) {
        delete (globalThis as Record<string, unknown>)[g]
      } else {
        ;(globalThis as Record<string, unknown>)[g] = original
      }
    }
  }
}

// ---------------------------------------------------------------------------
// activateCondition — helper for URL prop conformance tests
// ---------------------------------------------------------------------------

/**
 * Given a declarative PropertyCondition, return a partial props object that
 * satisfies the condition (so the prop is visible / active in render()).
 *
 * Used by the URL-prop conformance test to ensure conditional URL props
 * are actually rendered into HTML, making the safeUrl() call testable.
 *
 * Handles: eq, in, and, or. For notEq/notIn (hard to satisfy generically) returns {}.
 */
function activateCondition(condition: Record<string, unknown>): Record<string, unknown> {
  if (Array.isArray(condition['and'])) {
    // AND: satisfy all branches
    return Object.assign(
      {},
      ...(condition['and'] as Record<string, unknown>[]).map(activateCondition)
    )
  }
  if (Array.isArray(condition['or']) && (condition['or'] as unknown[]).length > 0) {
    // OR: satisfy the first branch
    return activateCondition((condition['or'] as Record<string, unknown>[])[0])
  }
  if ('eq' in condition && 'field' in condition) {
    return { [condition['field'] as string]: condition['eq'] }
  }
  if ('in' in condition && 'field' in condition && Array.isArray(condition['in'])) {
    return { [condition['field'] as string]: (condition['in'] as unknown[])[0] }
  }
  // notEq / notIn: can't determine a valid value generically — return empty
  return {}
}

// ---------------------------------------------------------------------------
// runModuleConformanceSuite
// ---------------------------------------------------------------------------

/**
 * Register the full Module contract test suite for a given ModuleDefinition.
 * Call this at module-level in your test file — it creates a `describe` block.
 *
 * Covers:
 *   - Identity contract (id format, name, category, version, trusted, canHaveChildren)
 *   - Schema contract (flat keys, plain object)
 *   - render() interface contract (return type, purity)
 *   - Security contract (no banned globals, no raw <script> in default output)
 *   - Children contract (only when canHaveChildren is true)
 *
 * @example
 * import { TextModule } from '@modules/base/text'
 * runModuleConformanceSuite(TextModule)
 */
export function runModuleConformanceSuite(def: AnyModuleDefinition): void {
  describe(`Module conformance — ${def.id}`, () => {
    it('satisfies the module contract', () => {
      expect(def.id).toBeTruthy()
      expect(def.id).toMatch(/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/)
      expect(typeof def.name).toBe('string')
      expect(def.name.trim().length).toBeGreaterThan(0)
      expect(typeof def.category).toBe('string')
      expect(def.category.trim().length).toBeGreaterThan(0)
      expect(def.version).toMatch(/^\d+\.\d+\.\d+/)
      expect(typeof def.trusted).toBe('boolean')
      expect(typeof def.canHaveChildren).toBe('boolean')

      expect(def.schema).toBeTruthy()
      expect(typeof def.schema).toBe('object')
      expect(Array.isArray(def.schema)).toBe(false)
      for (const key of Object.keys(def.schema)) {
        expect(key).not.toContain('.')
      }

      expect(def.defaults).toBeTruthy()
      expect(typeof def.defaults).toBe('object')
      expect(Array.isArray(def.defaults)).toBe(false)

      // Modules that have migrated to htmlContract (no render) skip the
      // render-specific conformance checks — those are covered by the
      // htmlContract test suite instead.
      if (!def.render) return

      const result = def.render(def.defaults, [])
      expect(typeof result).toBe('object')
      expect(result).not.toBeNull()
      expect(typeof result.html).toBe('string')
      if (result.css !== undefined) {
        expect(typeof result.css).toBe('string')
      }

      const children = ['<span>child</span>']
      const r1 = def.render(def.defaults, children)
      const r2 = def.render(def.defaults, children)
      expect(r1.html).toBe(r2.html)
      expect(r1.css).toBe(r2.css)

      expect(() =>
        withBannedGlobals(() => def.render(def.defaults, []))
      ).not.toThrow()

      expect(/<script[\s>]/i.test(result.html)).toBe(false)
      expect(/\bon\w+\s*=/i.test(result.html)).toBe(false)

      const urlPropEntries = Object.entries(def.schema).filter(([, ctrl]) =>
        new Set<PropertyControl['type']>(['url', 'image', 'media']).has((ctrl as PropertyControl).type)
      )
      const unsafeVectors: Array<{ scheme: string; payload: string }> = [
        { scheme: 'javascript:', payload: 'javascript:alert(1)' },
        { scheme: 'data:', payload: 'data:text/html,<script>alert(1)</script>' },
        { scheme: 'vbscript:', payload: 'vbscript:MsgBox(1)' },
        { scheme: 'javascript:', payload: 'java\tscript:alert(1)' },
      ]

      for (const [propKey, ctrl] of urlPropEntries) {
        const c = ctrl as PropertyControl
        const activatingProps = c.condition
          ? activateCondition(c.condition as Record<string, unknown>)
          : {}

        for (const { scheme, payload } of unsafeVectors) {
          const testProps = { ...def.defaults, ...activatingProps, [propKey]: payload }
          const { html } = def.render(testProps, [])
          expect(html).not.toContain(scheme)
        }
      }

      if (def.canHaveChildren && !new Set(['special', 'transparent']).has(def.publishBehavior ?? 'standard')) {
        const childHtml = '<p data-test-child="true">child content</p>'
        const { html } = def.render(def.defaults, [childHtml])
        expect(html).toContain(childHtml)
      }
    })
  })
}
