/* eslint-disable react-refresh/only-export-components */
/**
 * base.root - invisible page root container.
 */
import type { ModuleDefinition, ModuleComponentProps } from '../../core/module-engine/types'
import { registry } from '../../core/module-engine/registry'
import { cn } from '../../ui/cn'
import { rawBinding } from './styleBindings'
import styles from './root.module.css'

export type RootProps = Record<string, unknown>

const MODULE_CLASS = 'pb-root'

const RootEditorComponent = ({ children, mcClassName }: ModuleComponentProps<RootProps>) => (
  <div className={cn(styles.root, mcClassName)}>
    {children}
  </div>
)

export const RootModule: ModuleDefinition<RootProps> = {
  id: 'base.root',
  name: 'Page Root',
  category: 'Layout',
  version: '2.0.0',
  trusted: true,
  canHaveChildren: true,
  icon: 'FileText',

  schema: {},
  defaults: {},

  classStyleBindings: {
    backgroundColor: rawBinding('backgroundColor', { type: 'color', label: 'Background' }, '#ffffff'),
    color: rawBinding('color', { type: 'color', label: 'Text color' }, '#111827'),
  },

  component: RootEditorComponent,

  render: (_props, renderedChildren) => ({
    html: `<div class="${MODULE_CLASS}">${renderedChildren.join('')}</div>`,
    css: `.${MODULE_CLASS}{min-height:100vh;width:100%;background-color:#fff;color:#111827}`,
  }),

  toJsx: (_props, renderedChildren) =>
    `<div className="${MODULE_CLASS}">${renderedChildren.join('')}</div>`,
}

registry.register(RootModule)
