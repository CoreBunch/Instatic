export type ToolCallIcon =
  | 'add'
  | 'class'
  | 'code'
  | 'collection'
  | 'copy'
  | 'data'
  | 'delete'
  | 'document'
  | 'edit'
  | 'media'
  | 'move'
  | 'node'
  | 'open'
  | 'page'
  | 'preview'
  | 'runtime'
  | 'style'
  | 'template'
  | 'tokens'
  | 'tool'
  | 'users'

export type ToolCallTone = 'danger' | 'neutral' | 'read' | 'style' | 'write'

export interface ToolCallDisplay {
  title: string
  detail: string
  icon: ToolCallIcon
  tone: ToolCallTone
}

/**
 * Map a raw agent tool call (`actionType` + params) to a human-readable row:
 * a friendly title, a compact detail string, a category icon, and a tone.
 *
 * Tool names are normalised first (see `normalizeToolName`) so both the
 * historical short names (`set_color_tokens`, `insertHtml`, `render_snapshot`)
 * and the current provider names (`site_set_color_tokens`, `site_insert_html`,
 * `content_create_document`) resolve to the same canonical key.
 */
export function getToolCallDisplay(actionType: string, params: unknown): ToolCallDisplay {
  const toolName = normalizeToolName(actionType)
  const p = asRecord(params)

  switch (toolName) {
    case 'list_documents':
      return display('Listing documents', contentScopeDetail(p), 'document', 'read')
    case 'list_modules':
      return display('Listing modules', optionalString(p.query), 'collection', 'read')
    case 'list_tokens':
      return display('Listing tokens', tokenFilterDetail(p), 'tokens', 'read')
    case 'list_post_types':
      return display('Listing post types', '', 'data', 'read')
    case 'list_loop_sources':
      return display('Listing loop sources', '', 'data', 'read')
    case 'list_breakpoints':
      return display('Listing breakpoints', '', 'preview', 'read')

    case 'insert_html':
      return display('Inserting HTML', targetDetail('inside', p.parentId), 'code', 'write')
    case 'get_node_html':
      return display('Reading node HTML', nodeDetail(p.nodeId), 'node', 'read')
    case 'read_document':
      return display('Reading document', documentDetail(p.document), 'document', 'read')
    case 'open_document':
      return display('Opening document', documentDetail(p.document), 'open', 'read')
    case 'replace_node_html':
      return display('Replacing node HTML', nodeDetail(p.nodeId), 'code', 'write')
    case 'delete_node':
      return display('Deleting node', nodeDetail(p.nodeId), 'delete', 'danger')
    case 'update_node_props':
      return display('Updating node props', nodeBreakpointDetail(p.nodeId, p.breakpointId), 'edit', 'write')
    case 'move_node':
      return display('Moving node', targetDetail('to', p.newParentId), 'move', 'write')
    case 'rename_node':
      return display('Renaming node', optionalString(p.label), 'edit', 'write')
    case 'duplicate_node':
      return display('Duplicating node', duplicateNodeDetail(p.nodeId, p.count), 'copy', 'write')

    case 'apply_css':
      return cssOperationDisplay(p)
    case 'assign_class':
      return display('Assigning class', classDetail(p.classId, p.nodeId), 'class', 'style')
    case 'remove_class':
      return display('Removing class', classDetail(p.classId, p.nodeId), 'class', 'danger')

    case 'list_code_assets':
      return display('Listing code assets', titleCase(optionalString(p.type)), 'code', 'read')
    case 'read_code_asset':
      return display('Reading code asset', codeAssetDetail(p), 'code', 'read')
    case 'write_code_asset':
      return display('Writing code asset', codeAssetDetail(p), 'code', 'write')
    case 'patch_code_asset':
      return display('Patching code asset', codeAssetDetail(p), 'code', 'write')
    case 'inspect_code_runtime':
      return display('Inspecting code runtime', documentDetail(p.document), 'runtime', 'read')

    case 'add_page':
      return display('Adding page', optionalString(p.title), 'add', 'write')
    case 'delete_page':
      return display('Deleting page', pageDetail(p.pageId), 'delete', 'danger')
    case 'rename_page':
      return display('Renaming page', pageTitleDetail(p), 'page', 'write')
    case 'duplicate_page':
      return display('Duplicating page', pageTitleDetail(p), 'copy', 'write')
    case 'set_page_template':
      return display('Setting page template', templateTargetDetail(p), 'template', 'write')
    case 'clear_page_template':
      return display('Clearing page template', pageDetail(p.pageId), 'template', 'danger')

    case 'set_color_tokens':
      return display('Updating color tokens', tokenCountDetail(p.tokens), 'tokens', 'style')
    case 'set_font_tokens':
      return display('Updating font tokens', tokenCountDetail(p.tokens), 'tokens', 'style')
    case 'set_type_scale':
      return display('Updating type scale', scaleDetail(p.groupId, p.namingConvention), 'tokens', 'style')
    case 'set_spacing_scale':
      return display('Updating spacing scale', scaleDetail(p.groupId, p.namingConvention), 'tokens', 'style')
    case 'render_snapshot':
      return display('Capturing preview', previewDetail(p), 'preview', 'read')

    case 'list_collections':
      return display('Listing collections', '', 'collection', 'read')
    case 'get_collection_schema':
      return display('Reading collection schema', collectionDetail(p), 'collection', 'read')
    case 'get_document':
      return display('Reading document', contentDocumentDetail(p), 'document', 'read')
    case 'search_documents':
      return display('Searching documents', optionalString(p.query), 'document', 'read')
    case 'list_users':
      return display('Listing users', '', 'users', 'read')
    case 'list_media':
      return display('Listing media', optionalString(p.query), 'media', 'read')
    case 'create_document':
      return display('Creating document', contentDocumentDetail(p), 'add', 'write')
    case 'delete_document':
      return display('Deleting document', contentDocumentDetail(p), 'delete', 'danger')
    case 'set_document_status':
      return display('Setting document status', titleCase(optionalString(p.status)), 'edit', 'write')
    case 'set_document_field':
      return display('Updating document field', optionalString(p.field), 'edit', 'write')
    case 'set_document_fields':
      return display('Updating document fields', fieldCountDetail(p.fields), 'edit', 'write')
    case 'set_document_author':
      return display('Setting document author', optionalString(p.authorId ?? p.userId), 'users', 'write')
    case 'set_active_document':
      return display('Opening document', contentDocumentDetail(p), 'open', 'read')
    case 'set_active_collection':
      return display('Opening collection', collectionDetail(p), 'open', 'read')

    default:
      return display(`Running ${humanizeToolName(toolName)}`, '', 'tool', 'neutral')
  }
}

function display(title: string, detail: string, icon: ToolCallIcon, tone: ToolCallTone): ToolCallDisplay {
  return { title, detail, icon, tone }
}

export interface ColorSwatch {
  slug: string
  value: string
}

/**
 * Colour swatches to preview under a `set_color_tokens` row — the light value
 * of each token the agent created/updated. Empty for any other tool. Params
 * are read defensively (they arrive as `unknown` from the tool-call stream).
 */
export function extractColorSwatches(actionType: string, params: unknown): ColorSwatch[] {
  if (normalizeToolName(actionType) !== 'set_color_tokens') return []
  const tokens = asRecord(params).tokens
  if (!Array.isArray(tokens)) return []
  const swatches: ColorSwatch[] = []
  for (const entry of tokens) {
    const token = asRecord(entry)
    const slug = optionalString(token.slug)
    const value = optionalString(token.lightValue)
    if (slug && value) swatches.push({ slug, value })
  }
  return swatches
}

// Canonicalise a provider tool name to a stable snake_case key: drop the MCP
// namespace and the `site_`/`content_` domain prefixes, then fold any camelCase
// (historical names like `insertHtml`) down to snake_case.
function normalizeToolName(actionType: string): string {
  return actionType
    .replace(/^mcp__instatic__/, '')
    .replace(/^(site|content)_/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function optionalString(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

function shortId(value: unknown): string {
  const text = optionalString(value)
  return text.length > 12 ? `${text.slice(0, 12)}...` : text
}

function nodeDetail(nodeId: unknown): string {
  const id = shortId(nodeId)
  return id ? `node ${id}` : ''
}

function pageDetail(pageId: unknown): string {
  const id = shortId(pageId)
  return id ? `page ${id}` : ''
}

function targetDetail(prefix: string, idValue: unknown): string {
  const id = shortId(idValue)
  return id ? `${prefix} ${id}` : ''
}

function nodeBreakpointDetail(nodeId: unknown, breakpointId: unknown): string {
  const node = nodeDetail(nodeId)
  const breakpoint = optionalString(breakpointId)
  if (!node) return breakpoint
  return breakpoint ? `${node} at ${breakpoint}` : node
}

function duplicateNodeDetail(nodeId: unknown, count: unknown): string {
  const node = nodeDetail(nodeId)
  const copies = typeof count === 'number' && count > 1 ? `${count} copies` : ''
  if (!node) return copies
  return copies ? `${node}, ${copies}` : node
}

function classDetail(classId: unknown, nodeId: unknown): string {
  const className = optionalString(classId)
  const node = nodeDetail(nodeId)
  if (!className) return node
  return node ? `${className} on ${node}` : className
}

function documentDetail(value: unknown): string {
  const document = asRecord(value)
  const type = documentKind(optionalString(document.type))
  const id = shortId(document.id)
  if (!type) return id
  return id ? `${type} ${id}` : type
}

function documentKind(type: string): string {
  switch (type) {
    case 'page':
      return 'Page'
    case 'template':
      return 'Template'
    case 'visualComponent':
      return 'Visual component'
    default:
      return titleCase(type)
  }
}

function codeAssetDetail(params: Record<string, unknown>): string {
  return optionalString(params.path) || shortId(params.fileId)
}

function pageTitleDetail(params: Record<string, unknown>): string {
  return optionalString(params.title) || pageDetail(params.pageId)
}

function templateTargetDetail(params: Record<string, unknown>): string {
  const target = asRecord(params.target)
  const kind = optionalString(target.kind)
  const targetLabel = kind ? titleCase(kind) : ''
  const page = pageDetail(params.pageId)
  if (!page) return targetLabel
  return targetLabel ? `${page} - ${targetLabel}` : page
}

function tokenFilterDetail(params: Record<string, unknown>): string {
  return optionalString(params.family) || optionalString(params.category)
}

function tokenCountDetail(value: unknown): string {
  return countDetail(value, 'token', 'tokens')
}

function fieldCountDetail(value: unknown): string {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const count = Object.keys(value).length
    return count === 1 ? '1 field' : `${count} fields`
  }
  return countDetail(value, 'field', 'fields')
}

function countDetail(value: unknown, singular: string, plural: string): string {
  if (!Array.isArray(value)) return ''
  return value.length === 1 ? `1 ${singular}` : `${value.length} ${plural}`
}

function scaleDetail(groupId: unknown, namingConvention: unknown): string {
  return optionalString(groupId) || optionalString(namingConvention)
}

function previewDetail(params: Record<string, unknown>): string {
  const node = nodeDetail(params.nodeId)
  const breakpoint = optionalString(params.breakpointId)
  if (!node) return breakpoint
  return breakpoint ? `${node} at ${breakpoint}` : node
}

function contentScopeDetail(params: Record<string, unknown>): string {
  return collectionDetail(params) || optionalString(params.status)
}

function collectionDetail(params: Record<string, unknown>): string {
  return optionalString(params.tableId)
    || optionalString(params.tableSlug)
}

function contentDocumentDetail(params: Record<string, unknown>): string {
  return optionalString(params.title)
    || shortId(params.documentId)
    || shortId(params.rowId)
    || collectionDetail(params)
}

function summarizeCss(css: string): string {
  if (!css) return ''
  const selectors = css
    .match(/[^{}]+(?=\{)/g)
    ?.map((selector) => selector.trim().replace(/\s+/g, ' '))
    .filter(Boolean) ?? []
  if (selectors.length === 0) return 'CSS changes'
  const head = selectors.slice(0, 2).join(', ')
  return selectors.length > 2 ? `${head} +${selectors.length - 2}` : head
}

function cssOperationDisplay(params: Record<string, unknown>): ToolCallDisplay {
  const operation = optionalString(params.operation)
  if (operation === 'replace') {
    return display('Replacing CSS', summarizeCss(optionalString(params.css)), 'style', 'style')
  }
  if (operation === 'delete') {
    return display('Deleting CSS rules', summarizeStringList(params.selectors), 'delete', 'danger')
  }
  if (operation === 'remove-properties') {
    const selectors = summarizeStringList(params.selectors)
    const properties = summarizeStringList(params.properties)
    const detail = [selectors, properties].filter(Boolean).join(' · ')
    return display('Removing CSS properties', detail, 'style', 'danger')
  }
  return display('Updating CSS', summarizeCss(optionalString(params.css)), 'style', 'style')
}

function summarizeStringList(value: unknown): string {
  if (!Array.isArray(value)) return ''
  const items = value.filter((item): item is string => typeof item === 'string' && item.length > 0)
  if (items.length === 0) return ''
  const head = items.slice(0, 2).join(', ')
  return items.length > 2 ? `${head} +${items.length - 2}` : head
}

function humanizeToolName(toolName: string): string {
  return toolName
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase()
}

function titleCase(value: string): string {
  if (!value) return ''
  return value
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}
