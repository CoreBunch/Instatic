import { findColorVariable } from '@ui/lib/colorVariable'
import { ColorPicker } from '@ui/components/ColorPicker'
import { generateFrameworkColorVariableSets } from '@core/framework'
import { getErrorMessage } from '@core/utils/errorMessage'
import { pushToast } from '@ui/components/Toast'
import { useEditorStore } from '@site/store/store'
import { useEditorPermissions } from '@site/editorPermissionsContext'

export default function FrameworkColorPicker({ value, gradients, onChange }: {
  value: string
  gradients?: boolean
  onChange: (value: string) => void
}) {
  const colors = useEditorStore((s) => s.site?.settings.framework?.colors)
  const create = useEditorStore((s) => s.createFrameworkColorToken)
  const { canEditStyle } = useEditorPermissions()
  const tokens = generateFrameworkColorVariableSets(colors).light
  const assigned = findColorVariable(value, tokens)
  function saveColor(name: string, color: string) {
    try {
      const saved = create({ slug: name, lightValue: color, darkModeEnabled: false })
      if (!saved) return null
      pushToast({ kind: 'success', title: `Saved --${saved.slug} to Framework colors` })
      return { name: `--${saved.slug}`, value: color }
    } catch (err) {
      pushToast({ kind: 'error', title: 'Could not save Framework color', body: getErrorMessage(err, 'Unknown color error') })
      return null
    }
  }
  return <ColorPicker value={assigned?.value ?? value} assignedToken={assigned?.name} gradients={gradients} tokens={tokens}
    onSaveColor={canEditStyle && !assigned ? saveColor : undefined} onChange={onChange} />
}
