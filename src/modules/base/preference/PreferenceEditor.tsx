import type { ModuleComponentProps } from '@core/module-engine'
import { CanvasModulePlaceholder } from '@ui/components/CanvasModulePlaceholder'
import { useEditorStore } from '@site/store/store'
import { preferenceChoices, preferenceCaptions, PreferencePublishSchema, type PreferenceStoredProps } from './props'
import { compiledCheck } from '@core/utils/typeboxCompiler'

export function PreferenceEditor({ props, mcClassName, nodeWrapperProps }: ModuleComponentProps<PreferenceStoredProps>) {
  const settings = useEditorStore(state => state.site?.settings)
  const configured = settings?.visitorPreferences
  if (!configured) return <CanvasModulePlaceholder {...nodeWrapperProps} className={mcClassName} label="Configure visitor defaults in Site Settings before publishing this preference control." />
  if (!compiledCheck(PreferencePublishSchema, { props, settings })) return <CanvasModulePlaceholder {...nodeWrapperProps} className={mcClassName} label="Preference controls require authored labels, option captions and status captions before publishing." />
  return (
    <div {...nodeWrapperProps} className={mcClassName} data-instatic-preference-control="" data-instatic-preference={props.preference}>
      <label>{props.label}<select data-instatic-preference-value="" defaultValue={configured[props.preference]}>
        {preferenceChoices(props).map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
      </select></label>
      <p data-instatic-preference-feedback="" aria-live="off">
        {Object.entries(preferenceCaptions(props)).map(([status, caption]) => <span key={status} data-instatic-preference-status={status} hidden={status !== 'preview'}>{caption}</span>)}
      </p>
    </div>
  )
}
