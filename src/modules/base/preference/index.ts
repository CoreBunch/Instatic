import { registry, type ModuleDefinition } from '@core/module-engine'
import { Value } from '@core/utils/typeboxHelpers'
import { SettingsCogSolidIcon } from 'pixel-art-icons/icons/settings-cog-solid'
import { PreferenceEditor } from './PreferenceEditor'
import { PreferencePropsSchema, PreferencePublishSchema, preferenceChoices, preferenceCaptions, type PreferenceStoredProps } from './props'

export const PreferenceModule: ModuleDefinition<PreferenceStoredProps> = {
  id: 'base.preference', name: 'Visitor preference',
  description: 'A native select for appearance, motion, or decorative media preferences.',
  category: 'Interactive', version: '1.0.0', trusted: true, icon: SettingsCogSolidIcon,
  canHaveChildren: false, htmlTag: 'div',
  propsSchema: PreferencePropsSchema, publishSchema: PreferencePublishSchema,
  defaults: Value.Create(PreferencePropsSchema), component: PreferenceEditor,
  schema: {
    preference: { type: 'select', label: 'Preference', options: [{ value: 'theme', label: 'Appearance' }, { value: 'motion', label: 'Motion' }, { value: 'media', label: 'Decorative media' }] },
    label: { type: 'text', label: 'Label', category: 'content' },
    systemLabel: { type: 'text', label: 'System option', category: 'content' },
    defaultLabel: { type: 'text', label: 'Default palette option', category: 'content' },
    altLabel: { type: 'text', label: 'Alternate palette option', category: 'content' },
    fullLabel: { type: 'text', label: 'Full media option', category: 'content' },
    reducedLabel: { type: 'text', label: 'Reduced option', category: 'content' },
    defaultStatus: { type: 'text', label: 'Default status', category: 'content' },
    savedStatus: { type: 'text', label: 'Saved status', category: 'content' },
    sessionStatus: { type: 'text', label: 'Unsaved change status', category: 'content' },
    resetStatus: { type: 'text', label: 'Invalid saved state status', category: 'content' },
    unavailableStatus: { type: 'text', label: 'Storage unavailable status', category: 'content' },
    previewStatus: { type: 'text', label: 'Preview status', category: 'content' },
    invalidStatus: { type: 'text', label: 'Invalid choice status', category: 'content' },
  },
  render(props) {
    const options = preferenceChoices(props).map(choice => '<option value="' + choice.value + '">' + choice.label + '</option>').join('')
    const captions = Object.entries(preferenceCaptions(props)).map(([status, caption]) => '<span data-instatic-preference-status="' + status + '"' + (status === 'default' ? '' : ' hidden') + '>' + caption + '</span>').join('')
    return { html: '<div data-instatic-preference-control="" data-instatic-preference="' + props.preference + '"><label>' + props.label + '<select data-instatic-preference-value="" disabled>' + options + '</select></label><p data-instatic-preference-feedback="" aria-live="off">' + captions + '</p></div>' }
  },
}
registry.registerOrReplace(PreferenceModule)
