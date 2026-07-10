/**
 * base.slot-instance — materialized slot node in the consumer page tree.
 *
 * When a VC ref is dropped on a page, one `base.slot-instance` child is
 * auto-materialized per slot param the VC declares (in param order).
 * Each slot-instance is locked: it cannot be deleted, moved, or reordered
 * by the user. Its content (children) is fully editable.
 *
 * The publisher pairs each slot-instance (consumer side) with the matching
 * `base.slot-outlet` (in the VC's definition tree) by `slotName`, substituting
 * the slot-instance's children at the outlet's position.
 *
 * The render function returns empty HTML/CSS because the VC-ref renderer
 * extracts slot content from this node's children directly — the slot-instance
 * itself never renders as a standalone element in the published output.
 *
 * Architecture source: Task 4 of the Tree Unification Refactor.
 */
import type { ModuleDefinition } from '@core/module-engine'
import { registry } from '@core/module-engine'
import { TargetSolidIcon } from 'pixel-art-icons/icons/target-solid'
import { SlotInstanceEditor } from './SlotInstanceEditor'
import { Value } from '@core/utils/typeboxHelpers'
import { SlotInstancePropsSchema, type SlotInstanceStoredProps } from './props'

export const SlotInstanceModule: ModuleDefinition<SlotInstanceStoredProps> = {
  id: 'base.slot-instance',
  name: 'Slot',
  description: 'A materialized slot for component content',
  category: 'Components',
  version: '1.0.0',
  icon: TargetSolidIcon,
  trusted: true,
  canHaveChildren: true,

  // The slot-instance never renders as a standalone element — its children are
  // emitted at the matching slot-outlet position by the vc-ref renderer. Its
  // own render() returns empty (validated at registration).
  publishBehavior: 'transparent',

  schema: {
    slotName: {
      type: 'text',
      label: 'Slot name',
      placeholder: 'children',
      description: 'Identifies which slot outlet this content fills',
    },
  },

  propsSchema: SlotInstancePropsSchema,
  // Defaults derive from the schema so a new field can never be silently
  // dropped by a stale hand-written default.
  defaults: Value.Create(SlotInstancePropsSchema),

  component: SlotInstanceEditor,

  htmlContract: {
    canHaveChildren: true,
    // Transparent — the slot-instance never emits a wrapper element.
    // Its children are rendered at the matching slot-outlet position by
    // the publisher. No HTML element claims this module.
    fromHtml: () => null,
  },

  /**
   * Publisher safety-net: the walker reaches slot-instance only if the VC-ref
   * renderer somehow didn't intercept it. Return empty so the slot contributes
   * nothing to the published page on its own (its children are rendered at the
   * slot-outlet position instead).
   */
  render: () => ({ html: '', css: '' }),
}

registry.registerOrReplace(SlotInstanceModule)
