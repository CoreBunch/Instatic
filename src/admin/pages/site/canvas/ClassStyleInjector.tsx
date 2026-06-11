/**
 * ClassStyleInjector — injects/updates user class CSS into the target
 * document whenever the site's class registry changes.
 *
 * This is a pure side-effect component (renders null). It subscribes to
 * `site.styleRules` via a stable selector and imperatively manages a single
 * <style id="mc-classes"> element in the target document's <head>.
 *
 * Multi-document support
 * ──────────────────────
 * Each breakpoint frame in the canvas is its own iframe, with its own document.
 * `IframeFrameSurface` mounts one of these injectors per frame, targeting the
 * iframe's document. When no `targetDocument` prop is passed, the injector
 * falls back to the editor's main document — used by code paths that aren't
 * inside an iframe (none right now, but kept as a safe default).
 *
 * Architecture:
 * - One <style> tag per target document, kept in sync on every class
 *   registry change.
 * - CSS is generated from CSSPropertyBag by camelCase → kebab-case conversion.
 * - @media / `[data-breakpoint-id]` blocks are emitted for breakpoint overrides
 *   (uses site.breakpoints).
 * - No FOUC: the style element is created synchronously before first paint.
 *
 * Security (Constraint #228):
 * - Property names are validated against an allowlist (camelCase CSS properties).
 * - Values are sanitised via the canonical sanitiseCssValue() from publisher/utils.
 * - Only known CSS property names from CSSPropertyBag interface are emitted.
 *
 * Performance:
 * - Subscribes with granular selectors so re-renders only happen when the
 *   relevant slices actually change (not on every site edit).
 * - `generateCanvasClassCSS` is identity-memoized on its 8 inputs (see
 *   `createCanvasClassCssMemo`). All breakpoint-frame injectors render with
 *   the same store snapshot in the same commit, so the full registry CSS is
 *   generated ONCE per change and frames 2..N reuse the cached string. Only
 *   the per-frame viewport-unit resolution still runs per injector — its
 *   output genuinely differs per frame width.
 */

import { useEffect } from 'react'
import { useEditorStore } from '@site/store/store'
import { styleRuleSelector, type ConditionDef, type StyleRule } from '@core/page-tree'
import { selectorStatePseudo } from '@site/cssStatePseudo'
import { generateCanvasClassCSS, generateForcedStateCSS, generatePreviewClassCSS } from './canvasClassCss'
import { resolveViewportUnitsForCanvas, type CanvasViewport } from './resolveViewportUnits'

interface ClassStyleInjectorProps {
  /**
   * Document to inject the <style> tag into. Defaults to the editor's main
   * document. Pass an iframe's `contentDocument` to scope the injection to
   * a single breakpoint frame.
   */
  targetDocument?: Document
  /**
   * Frame viewport used to resolve CSS viewport units (`vh`/`vw`/…) in class
   * styles to fixed px so they don't feed the iframe's grow-to-content height
   * loop. When omitted (non-iframe contexts), CSS is injected verbatim. See
   * `resolveViewportUnits.ts`.
   */
  viewport?: CanvasViewport
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const STYLE_TAG_ID = 'mc-classes'
const PREVIEW_STYLE_TAG_ID = 'mc-classes-preview'
const FORCE_STATE_STYLE_TAG_ID = 'mc-classes-force-state'

/**
 * Stable empty array used as the ?? fallback for breakpoints selector.
 * Must be module-scope so it's reference-stable across renders — an inline `?? []`
 * literal creates a new array instance on every call, forcing unnecessary re-renders
 * (Guideline #239 — Zustand selectors must not use inline ?? [] / ?? {} fallbacks).
 */
const EMPTY_BREAKPOINTS: Array<{ id: string; width: number }> = []

/** Stable empty fallback for the conditions selector (Guideline #239). */
const EMPTY_CONDITIONS: ConditionDef[] = []

/**
 * Stable empty registry passed to `generateCanvasClassCSS` when the site has
 * no style rules. An inline `{}` literal would mint a new identity per effect
 * run, defeating the generator's input-identity memo across frames.
 */
const EMPTY_STYLE_RULES: Record<string, StyleRule> = {}

export function ClassStyleInjector({ targetDocument, viewport }: ClassStyleInjectorProps = {}) {
  // Subscribe to class registry — shallow equality so we only re-run when
  // the classes object reference changes (Immer always creates a new ref on mutation)
  const classes = useEditorStore((s) => s.site?.styleRules ?? null)
  const breakpoints = useEditorStore((s) => s.site?.breakpoints ?? EMPTY_BREAKPOINTS)
  const conditions = useEditorStore((s) => s.site?.conditions ?? EMPTY_CONDITIONS)
  const frameworkColors = useEditorStore((s) => s.site?.settings.framework?.colors ?? null)
  const frameworkTypography = useEditorStore((s) => s.site?.settings.framework?.typography ?? null)
  const frameworkSpacing = useEditorStore((s) => s.site?.settings.framework?.spacing ?? null)
  const frameworkPreferences = useEditorStore((s) => s.site?.settings.framework?.preferences ?? null)
  const fonts = useEditorStore((s) => s.site?.settings.fonts ?? null)
  const previewClassStyles = useEditorStore((s) => s.previewClassStyles)
  const activeClassId = useEditorStore((s) => s.activeClassId)
  const selectedNodeId = useEditorStore((s) => s.selectedNodeId)

  useEffect(() => {
    const targetDoc = targetDocument ?? document
    // Get or create the <style> element inside the target document.
    let styleEl = targetDoc.getElementById(STYLE_TAG_ID) as HTMLStyleElement | null
    if (!styleEl) {
      styleEl = targetDoc.createElement('style')
      styleEl.id = STYLE_TAG_ID
      styleEl.setAttribute('data-source', 'ClassStyleInjector')
      targetDoc.head.appendChild(styleEl)
    }

    // Pin viewport units to the frame viewport (canvas-only) so class styles
    // using `vh`/`vmax`/… don't feed the iframe's grow-to-content height loop.
    const forCanvas = (css: string) => (viewport ? resolveViewportUnitsForCanvas(css, viewport) : css)

    const generated = generateCanvasClassCSS(
      classes ?? EMPTY_STYLE_RULES,
      breakpoints,
      conditions,
      frameworkColors,
      frameworkTypography,
      frameworkSpacing,
      frameworkPreferences,
      fonts,
    )
    // Wrap in a named cascade layer so editor-chrome CSS (unlayered, from
    // EditorChromeInjector) always wins over author CSS regardless of specificity.
    // The publisher reset, framework CSS, and class rules are all inside the layer;
    // their relative cascade among themselves is preserved (source order + specificity
    // within the layer). User CSS (also @layer user-authored) still wins over the
    // zero-specificity :where() publisher reset — same as before.
    const css = forCanvas(generated)
    styleEl.textContent = css
      ? `@layer user-authored {\n${css}\n}`
      : '/* no classes */'
  }, [targetDocument, viewport, classes, breakpoints, conditions, frameworkColors, frameworkTypography, frameworkSpacing, frameworkPreferences, fonts])

  // Preview overlay — a higher-specificity rule emitted while a user is
  // hovering a suggestion in a property control (e.g. spacing token
  // dropdown). Lives in its own <style> tag so it can be toggled cleanly
  // without re-running the main class-CSS generation.
  useEffect(() => {
    const targetDoc = targetDocument ?? document
    let previewEl = targetDoc.getElementById(PREVIEW_STYLE_TAG_ID) as HTMLStyleElement | null
    if (!previewClassStyles) {
      if (previewEl) previewEl.textContent = ''
      return
    }
    if (!previewEl) {
      previewEl = targetDoc.createElement('style')
      previewEl.id = PREVIEW_STYLE_TAG_ID
      previewEl.setAttribute('data-source', 'ClassStyleInjector:preview')
      targetDoc.head.appendChild(previewEl)
    }
    const cls = classes?.[previewClassStyles.classId]
    // State-pseudo rules are handled by the forced-state preview below — their
    // real `:hover`-style selector would never match here anyway.
    if (!cls || (cls.kind === 'ambient' && selectorStatePseudo(styleRuleSelector(cls)) !== null)) {
      previewEl.textContent = ''
      return
    }
    const previewCss = generatePreviewClassCSS(cls, {
      breakpointId: previewClassStyles.breakpointId ?? null,
      styles: previewClassStyles.styles,
    })
    const resolvedPreviewCss = viewport ? resolveViewportUnitsForCanvas(previewCss, viewport) : previewCss
    // Keep in the same @layer so the doubled-selector preview rule still wins
    // over the regular class rule within the layer (higher specificity).
    previewEl.textContent = resolvedPreviewCss
      ? `@layer user-authored {\n${resolvedPreviewCss}\n}`
      : ''
  }, [targetDocument, viewport, classes, previewClassStyles])

  // Forced state preview — when a state-pseudo selector (`.btn:hover`, …) is the
  // active selector, paint its declarations onto the selected node so the state
  // is visible/editable without physically triggering it (you can't toggle
  // `:hover` via the DOM). Plain classes are edited in place and need no force;
  // non-state ambients already match directly. In-flight edits to the same rule
  // are overlaid so dragging a control updates the preview live.
  useEffect(() => {
    const targetDoc = targetDocument ?? document
    let forceEl = targetDoc.getElementById(FORCE_STATE_STYLE_TAG_ID) as HTMLStyleElement | null
    const rule = activeClassId ? classes?.[activeClassId] : null
    const isStateRule = !!rule && rule.kind === 'ambient' && selectorStatePseudo(styleRuleSelector(rule)) !== null

    if (!rule || !isStateRule || !selectedNodeId) {
      if (forceEl) forceEl.textContent = ''
      return
    }
    if (!forceEl) {
      forceEl = targetDoc.createElement('style')
      forceEl.id = FORCE_STATE_STYLE_TAG_ID
      forceEl.setAttribute('data-source', 'ClassStyleInjector:force-state')
      targetDoc.head.appendChild(forceEl)
    }

    // Overlay an in-flight edit to the same rule into the context it targets so
    // dragging a control updates the forced preview live, at the right breakpoint.
    const inflight = previewClassStyles?.classId === activeClassId
      ? { contextId: previewClassStyles.breakpointId ?? null, styles: previewClassStyles.styles }
      : null
    const forcedCss = generateForcedStateCSS(selectedNodeId, rule, breakpoints, conditions, inflight)
    const resolved = viewport ? resolveViewportUnitsForCanvas(forcedCss, viewport) : forcedCss
    forceEl.textContent = resolved ? `@layer user-authored {\n${resolved}\n}` : ''
  }, [targetDocument, viewport, classes, breakpoints, conditions, activeClassId, selectedNodeId, previewClassStyles])

  // Cleanup: remove the style elements when the component unmounts. We
  // capture `targetDocument` into the effect so cleanup targets the same
  // document the effect installed to, even if the prop later changed.
  useEffect(() => {
    const targetDoc = targetDocument ?? document
    return () => {
      targetDoc.getElementById(STYLE_TAG_ID)?.remove()
      targetDoc.getElementById(PREVIEW_STYLE_TAG_ID)?.remove()
      targetDoc.getElementById(FORCE_STATE_STYLE_TAG_ID)?.remove()
    }
  }, [targetDocument])

  return null
}
