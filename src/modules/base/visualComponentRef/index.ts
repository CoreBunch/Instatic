/**
 * base.visual-component-ref — reference to a Visual Component.
 *
 * Drops a named VC instance onto a page or inside another VC.
 * The editor canvas renders the VC tree inline by instantiating it with
 * propOverrides substituted from per-param overrides. Double-click enters
 * the VC's own canvas for editing.
 * The publisher emits a comment marker; full emit is Phase 5.
 *
 * Slot content (user-authored content that fills the VC's slot outlets) lives
 * as `base.slot-instance` child nodes of this ref node in the page tree.
 * One slot-instance is auto-materialized per slot param the VC declares, in
 * param order, locked. The `slotContent` prop is gone — slot fills are
 * ordinary children of the slot-instance nodes.
 *
 * Architecture source: Contribution #619 §8 / Task 4 Tree Unification.
 */
import { registry } from '@core/module-engine'
import type { ModuleDefinition } from '@core/module-engine'
import { BracesIcon } from 'pixel-art-icons/icons/braces'
import { VisualComponentRefEditor } from './VisualComponentRefEditor'
import { Value } from '@core/utils/typeboxHelpers'
import {
  VisualComponentRefPropsSchema,
  type VisualComponentRefStoredProps,
} from './props'

export const VisualComponentRefModule: ModuleDefinition<VisualComponentRefStoredProps> = {
  id: 'base.visual-component-ref',
  name: 'Component',
  description: 'A reference to a Visual Component',
  category: 'Components',
  version: '1.0.0',
  icon: BracesIcon,
  trusted: true,
  canHaveChildren: true,

  // The publisher intercepts vc-ref nodes with `renderVisualComponentRef()`
  // instead of the standard walk — declared here so the dispatch is visible on
  // the definition.
  publishBehavior: 'special',

  // Props are not panel-edited — PropertiesPanel branches on moduleId and
  // renders ComponentRefView instead (Contribution #619 §8.5).
  schema: {},

  propsSchema: VisualComponentRefPropsSchema,
  // Defaults derive from the schema so a new field can never be silently
  // dropped by a stale hand-written default.
  defaults: Value.Create(VisualComponentRefPropsSchema),

  component: VisualComponentRefEditor,

  htmlContract: {
    canHaveChildren: true,
    // Special publisher path — the VC tree is inlined, so there is no
    // standalone wrapper element owned by this module. The root element
    // comes from the instantiated VC's root node. Not claimable from
    // imported HTML (VC refs are created by the editor, not imported).
    fromHtml: () => null,
  },

  /**
   * Defense-in-depth fallback: the publisher walker intercepts
   * base.visual-component-ref nodes via renderVisualComponentRef() in
   * render.ts before this method is ever called. This implementation is
   * intentionally unreachable under normal operation. When called, it
   * concatenates children (slot-instance content already extracted by the walker)
   * so the conformance contract `render() embeds children` is satisfied.
   */
  render: (_props, children) => ({ html: children.join('') }),
}

registry.registerOrReplace(VisualComponentRefModule)
