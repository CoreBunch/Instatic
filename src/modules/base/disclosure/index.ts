import type { ModuleDefinition } from '@core/module-engine'
import { registry } from '@core/module-engine'
import { Value } from '@core/utils/typeboxHelpers'
import { ChevronDownIcon } from 'pixel-art-icons/icons/chevron-down'
import { htmlAttributesAttr } from '@core/publisher'
import { htmlAttributesControl } from '@modules/base/shared/htmlAttributes'
import { DisclosureEditor } from './DisclosureEditor'
import { DisclosurePropsSchema, type DisclosureStoredProps } from './props'
import { DISCLOSURE_RUNTIME_JS } from './disclosureRuntimeJs'

export const DisclosureModule: ModuleDefinition<DisclosureStoredProps> = {
  id: 'base.disclosure',
  name: 'Disclosure',
  description: 'A native details/summary disclosure with optional dismissal behavior.',
  category: 'Interactive',
  version: '1.0.0',
  icon: ChevronDownIcon,
  trusted: true,
  canHaveChildren: true,
  htmlTag: 'details',
  propsSchema: DisclosurePropsSchema,
  defaults: Value.Create(DisclosurePropsSchema),
  schema: {
    label: { type: 'text', label: 'Summary', category: 'content' },
    group: { type: 'text', label: 'Exclusive group', category: 'layout', description: 'Disclosures with the same nonempty group name share one open panel.' },
    initiallyOpen: { type: 'toggle', label: 'Initially open' },
    closeOnEscape: { type: 'toggle', label: 'Close with Escape' },
    closeOnOutsidePointer: { type: 'toggle', label: 'Close on outside click or tap' },
    closeOnFocusLeave: { type: 'toggle', label: 'Close when focus leaves' },
    htmlAttributes: htmlAttributesControl(),
  },
  component: DisclosureEditor,
  assets: { js: DISCLOSURE_RUNTIME_JS },
  render(props, children) {
    // Dedicated props own open/name; custom attributes cannot contradict them.
    const attrs = Object.fromEntries(Object.entries(props.htmlAttributes).filter(([name]) => !['open', 'name'].includes(name.trim().toLowerCase())))
    return {
      html: `<details${htmlAttributesAttr(attrs)}${props.group ? ` name="${props.group}"` : ''}${props.initiallyOpen ? ' open' : ''} data-instatic-disclosure="" data-instatic-close-on-escape="${props.closeOnEscape}" data-instatic-close-on-outside-pointer="${props.closeOnOutsidePointer}" data-instatic-close-on-focus-leave="${props.closeOnFocusLeave}"><summary>${props.label}</summary>${children.join('')}</details>`,
    }
  },
}

registry.registerOrReplace(DisclosureModule)
