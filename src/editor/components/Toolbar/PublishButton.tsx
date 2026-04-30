import { useEditorStore } from '@core/editor-store/store'
import { Button } from '@ui/components/Button'
import { Icon } from '../../../ui/icons/Icon'

export function PublishButton() {
  const projectId = useEditorStore((state) => state.project?.id)
  return (
    <Button
      variant="primary"
      size="sm"
      accentFill
      disabled={!projectId}
      onClick={() => {
        if (projectId) window.location.assign(`/projects/${projectId}/publish`)
      }}
      aria-label="Open publish workspace"
      title="Publish"
    >
      <Icon name="upload" size={14} aria-hidden="true" />
      <span>Publish</span>
    </Button>
  )
}

