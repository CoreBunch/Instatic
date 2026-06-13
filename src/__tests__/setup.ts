/**
 * Global test setup — runs before every test file via bunfig.toml preload.
 *
 * Sets up a happy-dom environment so that @testing-library/react and
 * other DOM-dependent code can run in bun test without a real browser.
 *
 * Uses GlobalWindow (not Window) so that JS built-ins (SyntaxError, TypeError,
 * etc.) are available on the window object — required by @testing-library/dom's
 * querySelectorAll implementation.
 */
import { GlobalWindow } from 'happy-dom'

// happy-dom auto-fetches and parses every `<link rel="stylesheet">` inserted
// into the document — including the Google Fonts CSS that
// `loadFontPreview()` injects from `src/core/fonts/preview.ts`. The fetched
// CSS contains selectors happy-dom's parser can't represent, and the
// internal SyntaxError it throws crashes on `new this.window.SyntaxError(...)`
// in deno-style noise between test files (the link load is async and outlives
// the test that triggered it). Disabling CSS file loading silences the noise
// without affecting any assertion — no test actually inspects the parsed
// CSSRules from a `<link>` tag.
//
// Equivalent: `disableJavaScriptFileLoading: true` also disables the
// JavaScript loader that would otherwise fetch `<script src>` URLs from
// canvas previews.
const happyWindow = new GlobalWindow({
  url: 'http://localhost/',
  settings: {
    disableCSSFileLoading: true,
    disableJavaScriptFileLoading: true,
  },
})

// Assign the window and document globals first — other globals are derived from these
;(globalThis as Record<string, unknown>).window = happyWindow
;(globalThis as Record<string, unknown>).document = happyWindow.document

// Assign all remaining browser globals from the happy-dom GlobalWindow.
// This ensures built-in constructors (SyntaxError, HTMLElement, etc.) are
// accessible both as standalone globals AND as window.* properties.
const GLOBALS_TO_COPY = [
  'navigator',
  'location',
  'history',
  'screen',
  'HTMLElement',
  'Element',
  'Node',
  'Event',
  'CustomEvent',
  'KeyboardEvent',
  'MouseEvent',
  'FocusEvent',
  'InputEvent',
  'MutationObserver',
  'ResizeObserver',
  'IntersectionObserver',
  'DOMParser',
  'XMLSerializer',
  'URLSearchParams',
  'URL',
  'FormData',
  'Blob',
  'File',
  'FileReader',
  'Headers',
  'Request',
  'Response',
  'fetch',
  'AbortController',
  'AbortSignal',
  'crypto',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'queueMicrotask',
  'performance',
  'localStorage',
  'sessionStorage',
  'SyntaxError',
  'TypeError',
  'RangeError',
  'DOMException',
  'Text',
  'Comment',
  'DocumentFragment',
  'Range',
  'Selection',
  'Storage',
  'CSSStyleDeclaration',
  'HTMLInputElement',
  'HTMLButtonElement',
  'HTMLDivElement',
  'HTMLSpanElement',
  'HTMLAnchorElement',
  'HTMLFormElement',
  'HTMLSelectElement',
  'HTMLTextAreaElement',
  'SVGElement',
  // ShadowRoot is referenced by `@tiptap/extensions`'s `findScrollParent`
  // helper (used by the Placeholder extension's plugin view). happy-dom
  // provides the constructor on `window`; without copying it to the global
  // namespace, the `el.getRootNode() instanceof ShadowRoot` check throws.
  'ShadowRoot',
] as const

for (const key of GLOBALS_TO_COPY) {
  const val = (happyWindow as Record<string, unknown>)[key]
  if (val !== undefined) {
    ;(globalThis as Record<string, unknown>)[key] = val
  }
}

// ---------------------------------------------------------------------------
// Default user-preference fetches to the "never set" envelope.
//
// Admin surfaces load user preferences on mount (e.g. the module-inserter
// favourites via `useModuleInserterPreference` → `getUserPreference`), which
// fires a real `fetch` to `/admin/api/cms/me/preferences/<key>`. In tests that
// hits `http://localhost` and rejects with ECONNREFUSED. Because the
// preference store is a module-level singleton whose load promise can outlive
// the component that triggered it, that rejection surfaces during a LATER
// test's `cleanup()` as an `AggregateError` — a cross-test flake that depends
// on render timing (it was masked while canvas frames mounted slowly, and
// reappeared once they mount synchronously).
//
// Returning the server's "never set" signal (`{ value: null }`) makes every
// such load resolve cleanly to the caller's own default, with no network call.
// Tests that need specific preference data still override `globalThis.fetch`
// in their own setup; `getUserPreference` callers that inject a `fetchImpl`
// bypass this entirely.
{
  const realFetch = globalThis.fetch
  const PREFERENCES_PATH = '/admin/api/cms/me/preferences/'
  ;(globalThis as Record<string, unknown>).fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url
    const method = (init?.method ?? (input as Request).method ?? 'GET').toUpperCase()
    if (method === 'GET' && url.includes(PREFERENCES_PATH)) {
      return new Response(JSON.stringify({ value: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return realFetch(input, init)
  }) as typeof globalThis.fetch
}

// ---------------------------------------------------------------------------
// Tame DOM serialization in failure output.
//
// A happy-dom node is deeply circular (`ownerDocument` → every element →
// `affectsCache` arrays of thousands → back to the document). When ANY
// assertion fails or a component throws with a node in scope, bun's error
// reporter recurses the whole tree and prints MILLIONS of lines for a single
// failing test — drowning the run and making the real failure unfindable.
//
// Registering a custom inspector on the happy-dom `Node` prototype collapses
// every node to a one-line tag summary in inspect/expect output. This affects
// ONLY serialization — structural equality (`toEqual`), queries, and event
// dispatch are untouched (matchers compare the live objects, they don't go
// through inspect). One guard fixes every DOM-rendering test at once.
{
  const inspectCustom = Symbol.for('nodejs.util.inspect.custom')
  const NodeCtor = (happyWindow as unknown as { Node?: { prototype: object } }).Node
  if (NodeCtor?.prototype) {
    Object.defineProperty(NodeCtor.prototype, inspectCustom, {
      configurable: true,
      writable: true,
      enumerable: false,
      value(this: Record<string, unknown>): string {
        try {
          const nodeType = this['nodeType']
          if (nodeType === 1) {
            const tag = String(this['tagName'] ?? this['localName'] ?? 'element').toLowerCase()
            const id = this['id'] ? `#${String(this['id'])}` : ''
            const className = this['className']
            const cls =
              typeof className === 'string' && className.trim()
                ? `.${className.trim().split(/\s+/).join('.')}`
                : ''
            return `<${tag}${id}${cls}>`
          }
          if (nodeType === 3) return `#text ${JSON.stringify(String(this['textContent'] ?? '').slice(0, 60))}`
          if (nodeType === 8) return '#comment'
          if (nodeType === 9) return '#document'
          if (nodeType === 11) return '#document-fragment'
          return `[Node nodeType=${String(nodeType)}]`
        } catch {
          return '[Node]'
        }
      },
    })
  }
}

// happy-dom does not implement EventSource, but several admin layouts
// (AdminPageLayout, AdminCanvasLayout) construct one on mount via the
// plugin event bridge. Provide a no-op stub so tests can render those
// layouts without each test file needing its own polyfill.
// happy-dom creates fresh `Window` objects for `<iframe>` elements without
// copying the parent's built-in constructors. The canvas now renders each
// breakpoint frame inside an iframe, and selectors run against
// `iframe.contentDocument` from inside the page-tree React subtree. happy-dom
// internally calls `new this.window.SyntaxError(...)` when a selector fails;
// without our polyfill that fires `undefined is not a constructor` and
// crashes the test before any assertion runs. We monkey-patch the iframe
// contentDocument getter to lazily copy parent constructors onto each
// iframe's window so test queries behave the same as the host.
const IFRAME_GLOBAL_KEYS = [
  'SyntaxError',
  'TypeError',
  'RangeError',
  'DOMException',
  'Node',
  'Element',
  'HTMLElement',
  'Event',
  'CustomEvent',
  'KeyboardEvent',
  'MouseEvent',
  'getComputedStyle',
] as const

function polyfillIframeWindow(win: unknown): void {
  if (!win || typeof win !== 'object') return
  const target = win as Record<string, unknown>
  for (const key of IFRAME_GLOBAL_KEYS) {
    if (target[key] !== undefined) continue
    const parentValue = (globalThis as Record<string, unknown>)[key]
    if (parentValue !== undefined) target[key] = parentValue
  }
}

{
  const iframeProto = (happyWindow as unknown as { HTMLIFrameElement?: { prototype: object } })
    .HTMLIFrameElement?.prototype
  if (iframeProto) {
    const originalDescriptor = Object.getOwnPropertyDescriptor(iframeProto, 'contentDocument')
    if (originalDescriptor?.get) {
      Object.defineProperty(iframeProto, 'contentDocument', {
        configurable: true,
        get(this: HTMLIFrameElement) {
          const doc = originalDescriptor.get!.call(this)
          if (doc) polyfillIframeWindow((doc as Document).defaultView)
          return doc
        },
      })
    }
  }
}

if (typeof (globalThis as { EventSource?: unknown }).EventSource === 'undefined') {
  class StubEventSource {
    readonly url: string
    readonly withCredentials: boolean
    readonly readyState: number = 1
    onopen: ((this: StubEventSource, ev: Event) => unknown) | null = null
    onmessage: ((this: StubEventSource, ev: MessageEvent) => unknown) | null = null
    onerror: ((this: StubEventSource, ev: Event) => unknown) | null = null
    constructor(url: string | URL, init?: { withCredentials?: boolean }) {
      this.url = typeof url === 'string' ? url : url.toString()
      this.withCredentials = Boolean(init?.withCredentials)
    }
    addEventListener(): void {}
    removeEventListener(): void {}
    dispatchEvent(): boolean { return true }
    close(): void {}
  }
  ;(globalThis as { EventSource?: unknown }).EventSource = StubEventSource as unknown
}

// ---------------------------------------------------------------------------
// Global React Testing Library cleanup after every test.
//
// @testing-library/react auto-registers an `afterEach(cleanup)` ONLY when
// `afterEach` is a global (the Jest/Vitest convention). Under `bun test`
// `afterEach` is import-only, so auto-cleanup never installs: any test that
// renders a component and doesn't manually `cleanup()` leaves it mounted, and
// it lingers into the NEXT test file. When a later file's own `cleanup()`
// finally unmounts that stale tree, an effect or in-flight request that
// resolved after the originating test surfaces inside that unrelated test's
// `act()` as an `AggregateError` — a cross-file flake whose victim depends on
// file ordering. Registering cleanup here (from the preload, so it applies to
// every file) restores the intended per-test isolation. `cleanup()` is a no-op
// when nothing is mounted, so non-React tests are unaffected.
//
// Imported dynamically so it runs AFTER the happy-dom globals above are
// installed — a static top-level import would be hoisted and pull in React
// before `document` exists.
{
  const { afterEach } = await import('bun:test')
  const { cleanup } = await import('@testing-library/react')
  afterEach(() => {
    cleanup()
  })
}
