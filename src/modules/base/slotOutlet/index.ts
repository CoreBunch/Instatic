/**
 * base.slot-outlet — slot placeholder inside a Visual Component tree.
 *
 * Marks the position where slot content from a parent vcRef instance will
 * be injected at render time. Visually distinct (dashed outline) so the
 * VC author knows it is a slot, not a regular container.
 *
 * The `slotName` matches the `slotName` prop on the consumer's `base.slot-instance`
 * child in the page tree. The publisher substitutes the slot-instance's children here.
 *
 * Architecture source: Contribution #619 §8
 */
import type { ModuleDefinition } from '@core/module-engine'
import { registry } from '@core/module-engine'
import { TargetSolidIcon } from 'pixel-art-icons/icons/target-solid'
import { SlotOutletEditor } from './SlotOutletEditor'
import { Value } from '@core/utils/typeboxHelpers'
import { SlotOutletPropsSchema, type SlotOutletStoredProps } from './props'

export const SlotOutletModule: ModuleDefinition<SlotOutletStoredProps> = {
  id: 'base.slot-outlet',
  name: 'Slot',
  description: 'A slot placeholder for component content',
  category: 'Components',
  version: '1.0.0',
  icon: TargetSolidIcon,
  trusted: true,
  canHaveChildren: false,

  // The slot-outlet is a placeholder — the consumer's slot content is injected
  // at its position. Its own render() returns empty (validated at registration).
  publishBehavior: 'transparent',

  schema: {
    slotName: {
      type: 'text',
      label: 'Slot name',
      placeholder: 'children',
      description: 'camelCase identifier (e.g. children, header, footer)',
    },
  },

  propsSchema: SlotOutletPropsSchema,
  // Defaults derive from the schema so a new field can never be silently
  // dropped by a stale hand-written default.
  defaults: Value.Create(SlotOutletPropsSchema),

  component: SlotOutletEditor,

  htmlContract: {
    canHaveChildren: false,
    // Transparent placeholder — replaced by the consumer's slot-instance
    // children at publish time. No standalone HTML element.
    fromHtml: () => null,
  },

  /**
   * Publisher safety-net: the walker reaches slot-outlet only when
   * instantiateVCAtRef kept the outlet as a placeholder — meaning no slot
   * content was provided AND the slot param has no defaultValue. Return empty
   * HTML so the slot contributes nothing to the published page.
   */
  render: () => ({ html: '', css: '' }),
}

registry.registerOrReplace(SlotOutletModule)
