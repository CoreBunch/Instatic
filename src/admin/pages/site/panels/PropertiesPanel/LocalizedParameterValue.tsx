import { localizableComponentParameterIds } from '@core/visualComponents'
import { useEditorStore } from '@site/store/store'
import { useEditorPermissions } from '@site/editorPermissionsContext'
import { ParamRow } from './ParamRow'
import styles from './LocalizedParameterValue.module.css'

/** Translate a content default while keeping parameter names and bindings shared. */
export function LocalizedParameterValue({ vcId, paramId }: { vcId: string; paramId: string }) {
  const vc = useEditorStore((state) => state.site?.visualComponents?.find((component) => component.id === vcId))
  const updateValue = useEditorStore((state) => state.updateParamDefaultValue)
  const { canEditContent } = useEditorPermissions()
  const parameter = vc?.params.find((param) => param.id === paramId)
  if (!vc || !parameter || !localizableComponentParameterIds(vc).has(paramId)) return null
  return <fieldset disabled={!canEditContent} className={styles.parameter}>
    <ParamRow mode="plain" paramName={parameter.name} paramType={parameter.type}
      paramId={parameter.id} value={parameter.defaultValue} enumOptions={parameter.enumOptions}
      onValueChange={(value) => updateValue(vcId, paramId, value)} />
  </fieldset>
}
