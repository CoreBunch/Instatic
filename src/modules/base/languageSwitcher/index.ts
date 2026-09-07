import { registry, type ModuleDefinition } from '@core/module-engine'
import { Value } from '@core/utils/typeboxHelpers'
import { GlobeSolidIcon } from 'pixel-art-icons/icons/globe-solid'
import { LanguageSwitcherPropsSchema, type LanguageSwitcherProps } from './props'
import { LanguageSwitcherEditor } from './LanguageSwitcherEditor'

export const LanguageSwitcherModule: ModuleDefinition<LanguageSwitcherProps> = {
  id: 'base.language-switcher', name: 'Language switcher',
  description: 'Links to published translations of the current page or CMS item. Labels use the configured language names.',
  category: 'Interactive', version: '1.0.0', icon: GlobeSolidIcon,
  trusted: true, canHaveChildren: false, publishBehavior: 'special',
  propsSchema: LanguageSwitcherPropsSchema, defaults: Value.Create(LanguageSwitcherPropsSchema),
  schema: {
    label: { type: 'text', label: 'Accessible label' },
    display: { type: 'select', label: 'Display', options: [{ label: 'Language name', value: 'name' }, { label: 'Language code', value: 'code' }] },
    showCurrent: { type: 'toggle', label: 'Include current language' },
    hideIfSingle: { type: 'toggle', label: 'Hide when no other translation is online' },
  },
  component: LanguageSwitcherEditor, htmlTag: 'nav',
  // The publisher supplies the route inventory to its specialized renderer.
  render: () => ({ html: '' }),
}
registry.registerOrReplace(LanguageSwitcherModule)
