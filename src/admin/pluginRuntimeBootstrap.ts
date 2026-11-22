/**
 * Plugin runtime bootstrap — populates `globalThis.__instatic` with the
 * host's React, ReactDOM, JSX runtime, design-system primitives, and
 * plugin SDK builders so the import-map shims in `public/runtime/*.js`
 * can re-export them.
 *
 * Why a global object instead of separate code chunks served by Vite:
 *   1. We need plugins to share the *same* React module instance the
 *      editor uses. Splitting React into its own chunk would still
 *      duplicate React if the chunk wasn't reference-equal — globalThis
 *      makes the sharing explicit.
 *   2. Vite/Rollup's chunk-deduplication is build-time; the plugin's
 *      bundle is loaded at runtime via a path Vite never sees, so we
 *      can't rely on the bundler to dedupe.
 *   3. The shim files are pure ES modules served from `public/runtime/*.js`
 *      — small, hand-auditable, no rollup magic. They re-export from
 *      the global the host populated here.
 *
 * Lazy-evaluated runtime
 * ----------------------
 * The runtime imports its heavy deps via DYNAMIC `import(...)`, not
 * static. That keeps `@admin/plugin-host-ui`, `@admin/plugin-host-hooks`
 * (whose imports include `useEditorStore` from the 109 KB editor store
 * chunk), and `@core/plugin-sdk` OUT OF the AuthenticatedAdmin / dashboard
 * critical path. The dashboard never needs the editor store, so it never
 * has to wait for the store chunk to download + parse before painting.
 *
 * Callers (anything that's about to dynamically import a plugin module
 * compiled against the `/runtime/*.js` shims) MUST `await ensurePluginRuntime()`
 * before triggering the plugin import. The two callers today:
 *
 *   • `useInstalledEditorPlugins.ts` — wraps the `activateInstalledEditorPlugins`
 *     call. Plugins activate via dynamic-import which is gated on the
 *     runtime being ready.
 *   • `PluginPageRenderer.tsx` — calls `loadPluginAdminAppComponent` to
 *     render a plugin's admin app page. Gated on the runtime being ready.
 *
 * Subsequent calls are no-ops (idempotent — the install promise is cached).
 *
 * Safety: never expose host internals beyond what the plugin SDK
 * already documents. The shim files in `public/runtime/` form the
 * narrow contract — anything not re-exported there is private.
 */
import type * as ReactNs from 'react'
import type * as ReactJsxRuntimeNs from 'react/jsx-runtime'
import type * as ReactJsxDevRuntimeNs from 'react/jsx-dev-runtime'
import type * as ReactDOMNs from 'react-dom'

declare global {
  var __instatic: {
    React: typeof ReactNs
    ReactJsxRuntime: typeof ReactJsxRuntimeNs
    ReactJsxDevRuntime: typeof ReactJsxDevRuntimeNs
    ReactDOM: typeof ReactDOMNs
    hostUi: Record<string, unknown>
    hostHooks: Record<string, unknown>
    pluginSdk: Record<string, unknown>
  } | undefined
}

/** The frozen runtime shape we publish on `globalThis.__instatic`. */
type PluginRuntime = NonNullable<typeof globalThis.__instatic>

// Memoised install promise. The first caller triggers the dynamic
// imports; concurrent / subsequent callers receive the same resolved
// promise (idempotent).
let installPromise: Promise<void> | null = null

/**
 * Ensure `globalThis.__instatic` is populated. Returns a promise that
 * resolves once all the runtime deps (host UI, host hooks, plugin SDK)
 * have been loaded and the global is set.
 *
 * Call this BEFORE dynamically importing a plugin asset — the plugin module
 * evaluates its `import * as React from 'react'` statements via
 * the `/runtime/*.js` shims, which read `globalThis.__instatic`.
 *
 * Cost on first call: downloads + parses `@admin/plugin-host-ui`,
 * `@admin/plugin-host-hooks` (which pulls in the editor store chunk),
 * and `@core/plugin-sdk`. On a warm cache this is near-instant.
 *
 * Cost on subsequent calls: a cached `Promise.resolve()`.
 */
export function ensurePluginRuntime(): Promise<void> {
  if (installPromise !== null) return installPromise
  installPromise = doInstall()
  return installPromise
}

async function doInstall(): Promise<void> {
  // Parallel dynamic imports — Vite emits these as separate chunks that
  // aren't pulled into the AuthenticatedAdmin static dep graph.
  //
  // `react`, `react-dom`, and the JSX runtimes are in the eagerly-loaded
  // react-vendor chunk already, so these resolve from the V8 module
  // cache without a network hit. Listing them via dynamic import keeps
  // the surface symmetric (all runtime members go through the same
  // resolver) and lets the optimizer prove they aren't needed on the
  // login screen.
  const [
    React,
    ReactJsxRuntime,
    ReactJsxDevRuntime,
    ReactDOM,
    hostUiMod,
    hostHooksMod,
    pluginSdkMod,
  ] = await Promise.all([
    import('react'),
    import('react/jsx-runtime'),
    import('react/jsx-dev-runtime'),
    import('react-dom'),
    import('@admin/plugin-host-ui'),
    import('@admin/plugin-host-hooks'),
    import('@core/plugin-sdk'),
  ])

  if (globalThis.__instatic && globalThis.__instatic.React !== React) {
    // Defensive single-React check — see the previous installPluginRuntime
    // implementation for rationale. Fail loudly if a plugin author
    // accidentally bundled their own React.
    throw new Error(
      '[@instatic/runtime] Detected a second React instance during plugin runtime bootstrap. ' +
      `Host React: ${React.version}; existing React: ${globalThis.__instatic.React.version}. ` +
      'Plugin authors must build with `instatic-plugin build` so React is externalized.',
    )
  }

  const runtime = {
    React,
    ReactJsxRuntime,
    ReactJsxDevRuntime,
    ReactDOM,
    hostUi: Object.freeze({
      Alert: hostUiMod.Alert,
      Bars: hostUiMod.Bars,
      Button: hostUiMod.Button,
      Card: hostUiMod.Card,
      Checkbox: hostUiMod.Checkbox,
      Code: hostUiMod.Code,
      Delta: hostUiMod.Delta,
      EmptyState: hostUiMod.EmptyState,
      Heading: hostUiMod.Heading,
      Input: hostUiMod.Input,
      RangeTabs: hostUiMod.RangeTabs,
      SearchBar: hostUiMod.SearchBar,
      Select: hostUiMod.Select,
      Separator: hostUiMod.Separator,
      Sparkline: hostUiMod.Sparkline,
      Stack: hostUiMod.Stack,
      StackedBar: hostUiMod.StackedBar,
      StatValue: hostUiMod.StatValue,
      Switch: hostUiMod.Switch,
      Tab: hostUiMod.Tab,
      TabList: hostUiMod.TabList,
      TabPanel: hostUiMod.TabPanel,
      Tabs: hostUiMod.Tabs,
      Text: hostUiMod.Text,
      Textarea: hostUiMod.Textarea,
      Widget: hostUiMod.Widget,
      WidgetList: hostUiMod.WidgetList,
      WidgetListRow: hostUiMod.WidgetListRow,
      SkeletonBlock: hostUiMod.SkeletonBlock,
      SkeletonCards: hostUiMod.SkeletonCards,
      SkeletonRows: hostUiMod.SkeletonRows,
      SegmentedControl: hostUiMod.SegmentedControl,
      TagPill: hostUiMod.TagPill,
      Kbd: hostUiMod.Kbd,
      ShortcutKeys: hostUiMod.ShortcutKeys,
    }),
    hostHooks: Object.freeze({
      PluginContext: hostHooksMod.PluginContext,
      useEditorStore: hostHooksMod.useEditorStore,
      usePluginSettings: hostHooksMod.usePluginSettings,
      usePluginContext: hostHooksMod.usePluginContext,
      usePluginRoutes: hostHooksMod.usePluginRoutes,
      useEditorCommand: hostHooksMod.useEditorCommand,
      useCanvasNodeRect: hostHooksMod.useCanvasNodeRect,
      useCanvasViewport: hostHooksMod.useCanvasViewport,
    }),
    pluginSdk: Object.freeze({
      PLUGIN_API_VERSION: pluginSdkMod.PLUGIN_API_VERSION,
      definePluginPanel: pluginSdkMod.definePluginPanel,
      definePluginCanvasOverlay: pluginSdkMod.definePluginCanvasOverlay,
      definePluginAdminApp: pluginSdkMod.definePluginAdminApp,
      definePlugin: pluginSdkMod.definePlugin,
      defineModule: pluginSdkMod.defineModule,
      defineComponent: pluginSdkMod.defineComponent,
      definePack: pluginSdkMod.definePack,
      permissions: pluginSdkMod.permissions,
      control: pluginSdkMod.control,
      html: pluginSdkMod.html,
      raw: pluginSdkMod.raw,
      escapeHtml: pluginSdkMod.escapeHtml,
      safeUrl: pluginSdkMod.safeUrl,
      createNamespace: pluginSdkMod.createNamespace,
      h: pluginSdkMod.h,
      vc: pluginSdkMod.vc,
    }),
  }

  // Freeze the top-level so a plugin (or stray third-party script) cannot
  // overwrite `__instatic.hostUi` etc. and substitute components.
  // The shim files in `public/runtime/*.js` rely on these references being
  // stable for the lifetime of the page.
  //
  // The cast pins the runtime's React/ReactDOM/JSX-runtime members to the
  // type-only namespace shape declared on `globalThis.__instatic`. Under
  // `verbatimModuleSyntax: true` + `moduleResolution: bundler` + no
  // `esModuleInterop`, TS infers `await import('react')` as a wider union
  // (it includes the synthetic CJS-interop default shape on top of the
  // namespace). The runtime values ARE the namespaces — there is no second
  // module instance in play — so the narrowing is a true statement, not a
  // band-aid. This is the only place that knows how the dynamic-import
  // results land in the strict global contract.
  globalThis.__instatic = Object.freeze(runtime) as PluginRuntime
}
