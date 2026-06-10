/**
 * Server-side render of the agent's posted tree into the HTML read surface.
 *
 * `renderAgentPage` produces the artifacts the model edits: the annotated
 * `<body>` (each element tagged `uid="<nodeId>"`) plus page-relevant CSS in a
 * `<style>` block. It intentionally does NOT inline the public full-site CSS
 * bundle: browser-only font-face declarations and unrelated imported-page
 * ambient selectors are dead weight in model context. Reset CSS is also
 * omitted — it is page-independent browser-normalisation boilerplate the agent
 * never reasons about.
 */

import { registry } from '@core/module-engine'
import type {
  AnyModuleDefinition,
  PropertyControl,
  PropertySchema,
} from '@core/module-engine'
import {
  collectUserStylesheetCss,
  generateFrameworkCss,
  generateClassCSS,
  publishPage,
  renderNode,
  sanitizeModuleCSS,
  type SiteCssBundle,
} from '@core/publisher'
import { describeFrameworkTokens } from '@core/framework'
import { describeFontTokens, generateFontTokenVariablesCss } from '@core/fonts'
import {
  isGeneratedClass,
  type Page,
  type SiteDocument,
  type StyleRule,
} from '@core/page-tree'
import type { SiteAgentSnapshot } from '@site/agent/siteAgentSnapshot'
import type { ModuleInfo, ModulePropInfo, ModuleStyleInfo, SnapshotTokens } from './snapshot'

/** A single token family name within `SnapshotTokens`. */
export type TokenFamily = keyof SnapshotTokens

export interface AgentPageRender {
  /** Annotated inner <body> HTML (uid="<nodeId>" on each element). */
  html: string
  /** The page's CSS wrapped in a <style> block; '' when the page has no CSS. */
  css: string
  /** Paging and cleanup metadata for the returned read_page slice. */
  pageInfo: AgentPageInfo
}

export interface AgentPageInfo {
  part: number
  totalParts: number
  nextPart: number | null
  /** Hard ceiling for JSON.stringify({ html, css, pageInfo }).length. */
  maxChars: number
  /** Full cleaned html+css character count before paging. */
  totalChars: number
  /** Character count of the returned html+css slice before JSON escaping. */
  returnedChars: number
  /** JSON.stringify({ html, css, pageInfo }).length for this result. */
  serializedChars: number
  ranges: AgentPageRange[]
  cleanedStrings: AgentPageCleanedStrings
  note: string
}

export interface AgentPageRange {
  field: 'html' | 'css'
  start: number
  end: number
  totalChars: number
}

export interface AgentPageCleanedStrings {
  base64DataUrls: number
  longUrls: number
}

export interface AgentPageRenderOptions {
  part?: number
  maxSerializedChars?: number
}

const DEFAULT_READ_PAGE_MAX_SERIALIZED_CHARS = 80_000
const MIN_READ_PAGE_MAX_SERIALIZED_CHARS = 1_200
const PLACEHOLDER_TOTAL_PARTS = 999_999
const LONG_URL_MAX_CHARS = 240
const LONG_URL_PREFIX_CHARS = 160
const LONG_URL_SUFFIX_CHARS = 40
const BASE64_DATA_URL_MAX_PAYLOAD_CHARS = 96
const READ_PAGE_PAGING_NOTE =
  'read_page is size-budgeted. If nextPart is not null, call read_page with that part to continue. Long base64/data URLs and very long URLs are summarized; use node uid values with getNodeHtml when exact node markup is needed.'

const EMPTY_AGENT_CSS_BUNDLE: SiteCssBundle = {
  reset: { bundle: 'reset', filename: 'reset-empty.css', hash: 'empty', content: '' },
  framework: { bundle: 'framework', filename: 'framework-empty.css', hash: 'empty', content: '' },
  style: { bundle: 'style', filename: 'style-empty.css', hash: 'empty', content: '' },
  userStyles: { bundle: 'userStyles', filename: 'userStyles-empty.css', hash: 'empty', content: '' },
}

/** Extract the inner `<body>` HTML from a full published document. */
function extractBody(html: string): string {
  const m = html.match(/<body[^>]*>([\s\S]*)<\/body>/)
  return m ? m[1] : html
}

export function renderAgentPage(
  snap: SiteAgentSnapshot,
  options: AgentPageRenderOptions = {},
): AgentPageRender {
  const { page, site } = snap
  const { html: fullDocument } = publishPage(page, site, registry, {
    annotateNodeIds: true,
    cssEmission: 'external',
    cssBundle: EMPTY_AGENT_CSS_BUNDLE,
  })
  const cleanedStrings: AgentPageCleanedStrings = { base64DataUrls: 0, longUrls: 0 }
  const html = cleanAgentReadSurface(extractBody(fullDocument), cleanedStrings)
  const cssBody = [
    buildAgentFrameworkCss(site),
    collectPageModuleCss(page, site),
    collectAgentPageClassCss(page, site),
    collectUserStylesheetCss(site, page),
  ].filter(Boolean).join('\n\n')
  const css = cssBody ? cleanAgentReadSurface(`<style>\n${cssBody}\n</style>`, cleanedStrings) : ''

  return paginateAgentPage({ html, css, cleanedStrings }, options)
}

function buildAgentFrameworkCss(site: SiteDocument): string {
  return [
    generateFontTokenVariablesCss(site.settings.fonts),
    generateFrameworkCss(site),
  ].filter(Boolean).join('\n')
}

function paginateAgentPage(
  payload: { html: string; css: string; cleanedStrings: AgentPageCleanedStrings },
  options: AgentPageRenderOptions,
): AgentPageRender {
  const maxChars = normaliseMaxSerializedChars(options.maxSerializedChars)
  const requestedPart = normalisePart(options.part)
  const totalChars = payload.html.length + payload.css.length
  const chunks = buildPageChunks(payload, maxChars, totalChars)
  const totalParts = chunks.length
  const part = Math.min(requestedPart, totalParts)
  const chunk = chunks[part - 1]!
  return buildAgentPagePart(payload, chunk, {
    part,
    totalParts,
    nextPart: part < totalParts ? part + 1 : null,
    maxChars,
    totalChars,
  })
}

function normalisePart(part: number | undefined): number {
  return typeof part === 'number' && Number.isInteger(part) && part > 0 ? part : 1
}

function normaliseMaxSerializedChars(maxChars: number | undefined): number {
  if (typeof maxChars !== 'number' || !Number.isInteger(maxChars) || maxChars <= 0) {
    return DEFAULT_READ_PAGE_MAX_SERIALIZED_CHARS
  }
  return Math.max(maxChars, MIN_READ_PAGE_MAX_SERIALIZED_CHARS)
}

interface AgentPageChunk {
  start: number
  end: number
}

function buildPageChunks(
  payload: { html: string; css: string; cleanedStrings: AgentPageCleanedStrings },
  maxChars: number,
  totalChars: number,
): AgentPageChunk[] {
  if (totalChars === 0) return [{ start: 0, end: 0 }]

  const chunks: AgentPageChunk[] = []
  let start = 0
  while (start < totalChars) {
    let low = 1
    let high = totalChars - start
    let best = 0

    while (low <= high) {
      const size = Math.floor((low + high) / 2)
      const candidate = buildAgentPagePart(payload, { start, end: start + size }, {
        part: PLACEHOLDER_TOTAL_PARTS,
        totalParts: PLACEHOLDER_TOTAL_PARTS,
        nextPart: PLACEHOLDER_TOTAL_PARTS,
        maxChars,
        totalChars,
      })
      if (candidate.pageInfo.serializedChars <= maxChars) {
        best = size
        low = size + 1
      } else {
        high = size - 1
      }
    }

    if (best === 0) {
      throw new Error('read_page budget is too small to return paging metadata.')
    }

    chunks.push({ start, end: start + best })
    start += best
  }
  return chunks
}

function buildAgentPagePart(
  payload: { html: string; css: string; cleanedStrings: AgentPageCleanedStrings },
  chunk: AgentPageChunk,
  info: {
    part: number
    totalParts: number
    nextPart: number | null
    maxChars: number
    totalChars: number
  },
): AgentPageRender {
  const { html, css, ranges } = sliceAgentPagePayload(payload.html, payload.css, chunk)
  const result: AgentPageRender = {
    html,
    css,
    pageInfo: {
      part: info.part,
      totalParts: info.totalParts,
      nextPart: info.nextPart,
      maxChars: info.maxChars,
      totalChars: info.totalChars,
      returnedChars: html.length + css.length,
      serializedChars: 0,
      ranges,
      cleanedStrings: { ...payload.cleanedStrings },
      note: READ_PAGE_PAGING_NOTE,
    },
  }
  updateSerializedLength(result)
  return result
}

function updateSerializedLength(result: AgentPageRender): void {
  for (;;) {
    const next = JSON.stringify(result).length
    if (next === result.pageInfo.serializedChars) return
    result.pageInfo.serializedChars = next
  }
}

function sliceAgentPagePayload(
  html: string,
  css: string,
  chunk: AgentPageChunk,
): { html: string; css: string; ranges: AgentPageRange[] } {
  const ranges: AgentPageRange[] = []
  let htmlSlice = ''
  let cssSlice = ''

  const htmlEnd = Math.min(chunk.end, html.length)
  if (chunk.start < html.length && htmlEnd > chunk.start) {
    htmlSlice = html.slice(chunk.start, htmlEnd)
    ranges.push({ field: 'html', start: chunk.start, end: htmlEnd, totalChars: html.length })
  }

  const cssStart = Math.max(0, chunk.start - html.length)
  const cssEnd = Math.min(css.length, chunk.end - html.length)
  if (cssEnd > cssStart) {
    cssSlice = css.slice(cssStart, cssEnd)
    ranges.push({ field: 'css', start: cssStart, end: cssEnd, totalChars: css.length })
  }

  return { html: htmlSlice, css: cssSlice, ranges }
}

const BASE64_DATA_URL_RE =
  /\bdata:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+(?:;[a-zA-Z0-9.+-]+=[^,;\s"'()<>]+)*);base64,([a-zA-Z0-9+/=_-]+)/g
const DATA_URL_RE = /\bdata:[^\s"'()<>]+/g
const LONG_URL_RE = /\b(?:https?:\/\/|\/(?:uploads|media)\/)[^\s"'<>),]+/g

function cleanAgentReadSurface(value: string, counts: AgentPageCleanedStrings): string {
  return value
    .replace(BASE64_DATA_URL_RE, (match, mime: string, payload: string) => {
      if (payload.length <= BASE64_DATA_URL_MAX_PAYLOAD_CHARS) return match
      counts.base64DataUrls += 1
      return `data:${mime};base64,[omitted ${payload.length} chars]`
    })
    .replace(DATA_URL_RE, (match) => truncateLongUrl(match, counts))
    .replace(LONG_URL_RE, (match) => truncateLongUrl(match, counts))
}

function truncateLongUrl(value: string, counts: AgentPageCleanedStrings): string {
  if (value.length <= LONG_URL_MAX_CHARS) return value
  counts.longUrls += 1
  const omittedChars = value.length - LONG_URL_PREFIX_CHARS - LONG_URL_SUFFIX_CHARS
  return `${value.slice(0, LONG_URL_PREFIX_CHARS)}...[truncated ${omittedChars} chars]...${value.slice(-LONG_URL_SUFFIX_CHARS)}`
}

/**
 * Collect module CSS for the active page only. The public CSS bundle walks the
 * whole site because visitor pages share page-invariant files; `read_page`
 * inlines CSS into model context, so unrelated pages must not ride along.
 */
function collectPageModuleCss(page: Page, site: SiteDocument): string {
  const acc = {
    cssMap: new Map<string, string>(),
    jsMap: new Map<string, string>(),
    infiniteLoopIds: new Set<string>(),
    holeNodeIds: new Set<string>(),
  }
  renderNode(page.rootNodeId, { page, site, registry, breakpointId: undefined }, acc)
  return Array.from(acc.cssMap.values()).join('\n')
}

function collectAgentPageClassCss(page: Page, site: SiteDocument): string {
  if (!site.styleRules) return ''

  const usedClassIds = collectActivePageClassIds(page, site)
  const usedClassNames = new Set<string>()
  const rules: Record<string, StyleRule> = {}

  for (const id of usedClassIds) {
    const rule = site.styleRules[id]
    if (!rule || isGeneratedClass(rule) || rule.kind !== 'class') continue
    rules[id] = rule
    usedClassNames.add(rule.name)
  }

  for (const rule of Object.values(site.styleRules)) {
    if (rule.kind !== 'ambient' || isGeneratedClass(rule)) continue
    if (ambientRuleCanAffectPage(rule, usedClassNames)) rules[rule.id] = rule
  }

  return sanitizeModuleCSS(generateClassCSS(rules, site.breakpoints, site.conditions ?? []))
}

function collectActivePageClassIds(page: Page, site: SiteDocument): Set<string> {
  const ids = new Set<string>()
  for (const node of Object.values(page.nodes)) {
    for (const id of node.classIds ?? []) ids.add(id)
  }

  // Visual Components render inline when referenced by the active page. The
  // ref-to-definition graph can be nested, so keep VC class CSS conservative:
  // include class ids from all VC definitions rather than risking a missing
  // component-scoped selector in read_page.
  for (const vc of site.visualComponents ?? []) {
    for (const id of vc.classIds ?? []) ids.add(id)
    for (const node of Object.values(vc.tree.nodes)) {
      for (const id of node.classIds ?? []) ids.add(id)
    }
  }
  return ids
}

function ambientRuleCanAffectPage(rule: StyleRule, usedClassNames: Set<string>): boolean {
  if (rule.rawCss) return true
  const selectorClasses = selectorClassTokens(rule.selector)
  if (selectorClasses.length === 0) return true
  return selectorClasses.every((name) => usedClassNames.has(name))
}

const CLASS_SELECTOR_RE = /\.((?:\\.|[-_a-zA-Z0-9])+)/g

function selectorClassTokens(selector: string): string[] {
  const tokens: string[] = []
  for (const match of selector.matchAll(CLASS_SELECTOR_RE)) {
    tokens.push(match[1]!.replace(/\\([^\s])/g, '$1'))
  }
  return tokens
}

// ---------------------------------------------------------------------------
// Catalog derivations — the module/token surface the agent's catalog tools
// (`list_modules`, `list_tokens`) return. Sourced from the server registry +
// the posted site, replacing the old browser-flattened snapshot fields.
// ---------------------------------------------------------------------------

/** Describe every insertable module from the registry (excludes `base.body`). */
export function describeAgentModules(): ModuleInfo[] {
  return registry
    .list()
    .filter((mod) => mod.id !== 'base.body')
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(moduleDefinitionToModuleInfo)
}

/** Describe the site's design tokens (framework colors/typography/spacing + fonts). */
export function describeAgentTokens(site: SiteDocument): SnapshotTokens {
  return {
    ...describeFrameworkTokens(site.settings.framework),
    fonts: describeFontTokens(site.settings.fonts),
  }
}

/**
 * Narrow a token digest to one family, leaving the others empty so the shape
 * stays stable. Returns the full digest when no family is given.
 */
export function filterTokenFamily(tokens: SnapshotTokens, family?: TokenFamily): SnapshotTokens {
  if (!family) return tokens
  return {
    colors: family === 'colors' ? tokens.colors : [],
    typography: family === 'typography' ? tokens.typography : [],
    spacing: family === 'spacing' ? tokens.spacing : [],
    fonts: family === 'fonts' ? tokens.fonts : [],
  }
}

function moduleDefinitionToModuleInfo(mod: AnyModuleDefinition): ModuleInfo {
  return {
    id: mod.id,
    name: mod.name,
    description: mod.description,
    category: mod.category,
    canHaveChildren: mod.canHaveChildren,
    defaults: toSerializableRecord(mod.defaults ?? {}),
    props: schemaToModuleProps(mod.schema, mod.defaults ?? {}),
    styles: genericStyleHintsForModule(mod),
  }
}

function genericStyleHintsForModule(mod: AnyModuleDefinition): ModuleStyleInfo[] {
  if (mod.id === 'base.text' || mod.category.toLowerCase() === 'typography') {
    return [
      { key: 'fontFamily', type: 'text', label: 'Font family', defaultValue: 'inherit', cssProperties: ['fontFamily'] },
      { key: 'fontSize', type: 'text', label: 'Font size', defaultValue: '16px', cssProperties: ['fontSize'] },
      { key: 'fontWeight', type: 'select', label: 'Font weight', defaultValue: '400', cssProperties: ['fontWeight'], options: [
        { label: 'Regular', value: '400' },
        { label: 'Medium', value: '500' },
        { label: 'Semi bold', value: '600' },
        { label: 'Bold', value: '700' },
        { label: 'Black', value: '900' },
      ] },
      { key: 'lineHeight', type: 'text', label: 'Line height', defaultValue: '1.4', cssProperties: ['lineHeight'] },
      { key: 'letterSpacing', type: 'text', label: 'Letter spacing', defaultValue: '0px', cssProperties: ['letterSpacing'] },
      { key: 'color', type: 'color', label: 'Text color', defaultValue: 'inherit', cssProperties: ['color'] },
      { key: 'textAlign', type: 'select', label: 'Text align', defaultValue: 'left', cssProperties: ['textAlign'], options: [
        { label: 'Left', value: 'left' },
        { label: 'Center', value: 'center' },
        { label: 'Right', value: 'right' },
        { label: 'Justify', value: 'justify' },
      ] },
      { key: 'marginBottom', type: 'text', label: 'Bottom margin', defaultValue: '0px', cssProperties: ['marginBottom'] },
    ]
  }

  return []
}

function schemaToModuleProps(
  schema: PropertySchema,
  defaults: Record<string, unknown>,
): ModulePropInfo[] {
  const props: ModulePropInfo[] = []

  for (const [key, control] of Object.entries(schema)) {
    if (control.type === 'group') {
      props.push(...schemaToModuleProps(control.children, defaults))
      continue
    }
    props.push(controlToModuleProp(key, control, defaults[key]))
  }

  return props
}

function controlToModuleProp(
  key: string,
  control: Exclude<PropertyControl, { type: 'group' }>,
  defaultValue: unknown,
): ModulePropInfo {
  const prop: ModulePropInfo = {
    key,
    type: control.type,
    label: control.label,
    description: control.description,
    defaultValue: toSerializableValue(defaultValue),
  }

  if (control.breakpointOverridable === true) {
    prop.breakpointOverridable = true
  }

  if (control.type === 'select') {
    prop.options = control.options.map((option) => ({
      label: option.label,
      value: toSerializableValue(option.value),
    }))
  }

  return prop
}

function toSerializableRecord(record: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    result[key] = toSerializableValue(value)
  }
  return result
}

function toSerializableValue(value: unknown): unknown {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value
  }

  if (Array.isArray(value)) return value.map(toSerializableValue)

  if (typeof value === 'object' && value) {
    const result: Record<string, unknown> = {}
    for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
      result[key] = toSerializableValue(nestedValue)
    }
    return result
  }

  return String(value)
}
