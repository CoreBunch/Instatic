import { resolveProps, type PageNode } from '@core/page-tree'
import { validateNodeProps } from '@core/module-engine'
import { escapeHtml } from './utils'
import { injectNodeClassIds, injectNodeId, injectNodeInlineStyles } from './classInjection'
import type { RenderConfig } from './renderConfig'

/** Routes are supplied by the live inventory, never reconstructed from slugs. */
export function renderLanguageSwitcher(node: PageNode, config: RenderConfig): string {
  const definition = config.registry.get(node.moduleId)
  if (!definition) return ''
  const props = validateNodeProps(definition, resolveProps(node, config.breakpointId, definition.schema))
  const alternatives = config.languageAlternatives ?? []
  if (alternatives.length === 0 || (props.hideIfSingle === true && alternatives.length < 2)) return ''
  const links = alternatives.filter((alternative) => props.showCurrent !== false || !alternative.current).map((alternative) => {
    const label = props.display === 'code' ? alternative.code : alternative.name
    return `<a href="${escapeHtml(alternative.path)}" hreflang="${escapeHtml(alternative.code)}" lang="${escapeHtml(alternative.code)}"${alternative.current ? ' aria-current="page"' : ''}>${escapeHtml(label)}</a>`
  })
  if (links.length === 0) return ''
  const html = `<nav aria-label="${escapeHtml(String(props.label ?? 'Language'))}" data-instatic-language-switcher>${links.join(' ')}</nav>`
  const withClasses = injectNodeClassIds(html, node.classIds, config.site)
  const withStyles = injectNodeInlineStyles(withClasses, node.inlineStyles, config.mediaAssets)
  return config.annotateNodeIds ? injectNodeId(withStyles, node.id) : withStyles
}
