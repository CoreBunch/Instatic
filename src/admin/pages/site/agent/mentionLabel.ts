/**
 * MentionLabel — compute a human-readable label and a tag-derived color key
 * for a layer mention pill.
 *
 * The label is what the user sees; the colorKey is what drives the pill
 * accent so it matches the DOM tree's `<tag>` badge colour.
 */
import { registry } from '@core/module-engine'
import type { BaseNode, SiteDocument } from '@core/page-tree'
import {
  getNodeDisplayName,
  getNodeHtmlTag,
  getNodeClassNames,
} from '@core/page-tree'

export interface MentionLabelResult {
  label: string
  colorKey: string
}

export function getMentionLabelForNode(
  nodeId: string,
  node: BaseNode | undefined,
  site: SiteDocument | null,
): MentionLabelResult {
  if (!node) {
    return { label: nodeId, colorKey: nodeId }
  }

  const def = registry.get(node.moduleId)
  const classNames = getNodeClassNames(node, site?.styleRules)
  const htmlTag = getNodeHtmlTag(node, def)

  // Priority: class selector chip → html tag badge → module display name
  if (classNames.length > 0) {
    return { label: `.${classNames.join('.')}`, colorKey: htmlTag ?? classNames[0] }
  }
  if (htmlTag) {
    return { label: `<${htmlTag}>`, colorKey: htmlTag }
  }

  const displayName = getNodeDisplayName(node, def, site?.visualComponents)
  return { label: displayName, colorKey: displayName }
}
