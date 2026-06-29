/**
 * Headless site-read tools for MCP (design system + breakpoints).
 *
 * The agent reads (and writes) the site as HTML + CSS — pages come back as HTML
 * (`site_read_document`), and `site_read_styles` returns the design system as a CSS
 * stylesheet: design tokens (CSS custom properties) plus every class and
 * ambient rule. It is the exact CSS you write back with `site_apply_css`, so Instatic
 * just parses it back and forth. `site_list_breakpoints` returns the configured
 * viewport ids so `site_render_snapshot` can target one deliberately.
 *
 * Server-resolved + headless: reads the draft site shell straight from the DB
 * (`getDraftSite`) and reuses the publisher's CSS emitters. No editor, no
 * browser snapshot — fixing the old `site_list_tokens` / `site_list_breakpoints` (which
 * silently needed the editor's posted snapshot and returned nothing over MCP).
 */
import { Type } from '@core/utils/typeboxHelpers'
import { isGeneratedClass, styleRuleSelector, type SiteDocument, type StyleRule } from '@core/page-tree'
import { generateClassCSS, generateFrameworkCss } from '@core/publisher'
import type { CoreCapability } from '@core/capabilities'
import type { AiTool, ToolContext } from '../../runtime/types'
import { getDraftSite } from '../../../repositories/site'

const SITE_READ_CAPS: readonly CoreCapability[] = [
  'site.read',
  'site.structure.edit',
  'site.content.edit',
  'site.style.edit',
  'pages.edit',
]

const ReadStylesInput = Type.Object(
  {
    format: Type.Optional(
      Type.Union([Type.Literal('full'), Type.Literal('summary')], {
        description:
          'full (default) = the complete CSS stylesheet. summary = a compact catalog of class names + the token variables each references, no declarations — scan this first to learn what exists, then read full for the ones you will edit.',
      }),
    ),
    className: Type.Optional(
      Type.String({
        description: 'Limit output to one class by name (without the leading dot). Omit for the full stylesheet.',
      }),
    ),
    includeTokens: Type.Optional(
      Type.Boolean({
        description: 'Include the design-token (CSS custom property) definitions. Defaults to true; ignored when className is set.',
      }),
    ),
  },
  { additionalProperties: false },
)

export const styleMcpTools: AiTool[] = [
  {
    name: 'site_read_styles',
    description:
      "Read the site's design system as a CSS stylesheet — design tokens (CSS custom properties for colors, type scale, spacing) plus every class and ambient rule. This is the SAME CSS you write back with site_apply_css, so read it first to learn the available classes (e.g. .ist-btn) and token variables (e.g. var(--ist-accent)) before authoring HTML/CSS. Works headless — no open editor needed. Pass className to read one rule; omit for the whole sheet.",
    scope: 'site',
    execution: 'server',
    inputSchema: ReadStylesInput,
    requiredCapabilities: SITE_READ_CAPS,
    handler: async (input, ctx: ToolContext) => {
      const { format = 'full', className, includeTokens = true } = input as {
        format?: 'full' | 'summary'
        className?: string
        includeTokens?: boolean
      }
      const site = await getDraftSite(ctx.db)
      if (!site) return { ok: false, error: 'No site found.' }

      // Author-defined classes + ambient rules. Framework-generated utility
      // classes are excluded here — they ride in the token CSS below.
      const rules: Record<string, StyleRule> = {}
      for (const [id, rule] of Object.entries(site.styleRules)) {
        if (isGeneratedClass(rule)) continue
        if (className && !(rule.kind === 'class' && rule.name === className)) continue
        rules[id] = rule
      }

      // Compact catalog: selector + the token variables each rule references,
      // no declarations. Scan this first; read `full` only for rules you edit.
      if (format === 'summary' && !className) {
        const classes = Object.values(rules)
          .sort((a, b) => a.order - b.order)
          .map((rule) => ({
            selector: styleRuleSelector(rule),
            kind: rule.kind,
            tokens: collectTokenRefs(rule),
          }))
        return { classes, classCount: classes.length }
      }

      const parts: string[] = []
      if (includeTokens && !className) {
        // generateFrameworkCss reads site.settings.framework; pages/VCs/layouts
        // are irrelevant to token emission, so complete the SiteDocument shape
        // with empties.
        const doc: SiteDocument = { ...site, pages: [], visualComponents: [], layouts: [] }
        const tokenCss = generateFrameworkCss(doc).trim()
        if (tokenCss) parts.push(`/* === Design tokens === */\n${tokenCss}`)
      }
      const classCss = generateClassCSS(rules, site.breakpoints, site.conditions ?? []).trim()
      if (classCss) parts.push(`/* === Classes === */\n${classCss}`)

      if (className && parts.length === 0) {
        return { ok: false, error: `No class named "${className}" found.` }
      }

      return { css: parts.join('\n\n'), classCount: Object.keys(rules).length }
    },
  },
  {
    name: 'site_list_breakpoints',
    description:
      'List the configured viewport breakpoints (id, label, width), in order (the first is the base/widest context). Pass a breakpoint id to site_render_snapshot to capture a specific viewport. Headless — no editor needed.',
    scope: 'site',
    execution: 'server',
    inputSchema: Type.Object({}, { additionalProperties: false }),
    requiredCapabilities: SITE_READ_CAPS,
    handler: async (_input, ctx: ToolContext) => {
      const site = await getDraftSite(ctx.db)
      if (!site) return { ok: false, error: 'No site found.' }
      return {
        breakpoints: site.breakpoints.map((b, i) => ({
          id: b.id,
          label: b.label,
          width: b.width,
          isBase: i === 0,
        })),
      }
    },
  },
]

/** Unique `--token` variables referenced by a style rule's declarations. */
function collectTokenRefs(rule: StyleRule): string[] {
  const found = new Set<string>()
  const scan = (bag: Record<string, unknown> | undefined): void => {
    for (const value of Object.values(bag ?? {})) {
      if (typeof value !== 'string') continue
      for (const match of value.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g)) found.add(match[1]!)
    }
  }
  scan(rule.styles as Record<string, unknown>)
  for (const ctx of Object.values(rule.contextStyles ?? {})) scan(ctx as Record<string, unknown>)
  return [...found].sort()
}
