/**
 * base.list — ordered or unordered list.
 *
 * Emits a bare `<ul>` / `<ol>` with no default class or default CSS.
 * Visual styling is opt-in via user classes (mcClassName / multi-class system).
 */
import type { ModuleDefinition } from '@core/module-engine'
import { registry } from '@core/module-engine'
import { Value } from '@core/utils/typeboxHelpers'
import { ListBoxSolidIcon } from 'pixel-art-icons/icons/list-box-solid'
import { parseItems } from './items'
import { ListEditor } from './ListEditor'
import { ListPropsSchema, type ListStoredProps } from './props'

export const ListModule: ModuleDefinition<ListStoredProps> = {
  id: 'base.list',
  name: 'List',
  description: 'An ordered or unordered list.',
  category: 'Typography',
  version: '2.0.0',
  icon: ListBoxSolidIcon,
  trusted: true,
  canHaveChildren: false,

  schema: {
    items: {
      type: 'textarea',
      label: 'Items',
      rows: 5,
      placeholder: 'Item 1\nItem 2\nItem 3',
    },
    listType: {
      type: 'select',
      label: 'List type',
      options: [
        { label: 'Bullet', value: 'unordered' },
        { label: 'Numbered', value: 'ordered' },
      ],
    },
  },

  propsSchema: ListPropsSchema,
  defaults: Value.Create(ListPropsSchema),

  component: ListEditor,

  htmlTag: (props) => (props.listType === 'ordered' ? 'ol' : 'ul'),

  htmlContract: {
    tag: (props) => (props.listType === 'ordered' ? 'ol' : 'ul'),
    canHaveChildren: true,
    claimSelector: 'ul, ol',
    fromHtml: (el) => {
      const tag = el.tagName.toLowerCase()
      const items = Array.from(el.querySelectorAll(':scope > li'))
        .map((li) => li.textContent ?? '')
        .join('\n')
      return {
        items,
        listType: (tag === 'ol' ? 'ordered' : 'unordered') as ListStoredProps['listType'],
      }
    },
  },

  render: (props) => {
    const tag = props.listType === 'ordered' ? 'ol' : 'ul'
    const items = parseItems(String(props.items || ''))
    const liItems = items.map((item) => `<li>${item}</li>`).join('')
    return {
      html: `<${tag}>${liItems}</${tag}>`,
    }
  },
}

registry.registerOrReplace(ListModule)
