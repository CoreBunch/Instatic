/**
 * @core/templates — template resolution, composition, and validation.
 *
 * A template is a page-tree carrying a `target` (everywhere | postTypes) plus a
 * `priority`. The resolver collects every template matching a route, ordered
 * broadest → narrowest; the composer splices each inner tree into the outer
 * template's single `base.outlet`, producing one merged tree for `publishPage`.
 */

export {
  normalizeRouteBase,
  isTemplatePage,
  primaryTemplateTableSlug,
  templateTargetLabel,
  resolveTemplateChain,
  type RouteResolutionContext,
} from './templateMatching'
export { composeTemplateChain, type TerminalContent } from './templateCompose'
export { firstOutletId, treeHasOutlet, subtreeHasOutlet } from './outlet'
