/**
 * @core/templates — template resolution, composition, and validation.
 *
 * A template is a page-tree carrying a `target` (everywhere | postTypes |
 * notFound) plus a `priority`. The resolver collects every template matching a
 * route, ordered broadest → narrowest; the composer splices each inner tree
 * into the outer template's single `base.outlet`, producing one merged tree
 * for `publishPage`. The `notFound` target sits outside route matching — the
 * public router renders it directly for fall-through 404s.
 */

export {
  isTemplatePage,
  primaryTemplateTableSlug,
  templateTargetLabel,
  resolveTemplateChain,
  resolveNotFoundTemplate,
  normalizeRouteBase,
  type RouteResolutionContext,
} from './templateMatching'
export { buildMemberFrame, buildPageFrame, buildRouteFrame } from './contextFrames'
export type { MemberAppRequestFrame, MemberFrame } from './contextFrames'
export type { TemplateRenderDataContext } from './dynamicBindings'
export { composeTemplateChain } from './templateCompose'
export { firstOutletId, treeHasOutlet, subtreeHasOutlet } from './outlet'
export { composedNodeSourceId, isComposedNodeId } from './templateCompose'
export {
  readShowIf,
  showIfAllows,
  ShowIfSchema,
  SHOW_IF_PROP_KEY,
  SHOW_IF_NAME_REGEX,
  SHOW_IF_VALUE_MAX_LENGTH,
  type ShowIf,
  type ShowIfSource,
  type ShowIfTest,
} from './showIf'
