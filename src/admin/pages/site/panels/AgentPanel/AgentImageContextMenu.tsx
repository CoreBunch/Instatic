import { useEffect, useRef } from 'react'
import { canWriteMedia } from '@admin/access'
import { useAuthenticatedAdminUser } from '@admin/sessionContext'
import { getErrorMessage } from '@core/utils/errorMessage'
import { ContextMenu, ContextMenuItem } from '@ui/components/ContextMenu'
import { pushToast } from '@ui/components/Toast'
import { ArrowDownIcon } from 'pixel-art-icons/icons/arrow-down'
import { CopySolidIcon } from 'pixel-art-icons/icons/copy-solid'
import { ImagesSolidIcon } from 'pixel-art-icons/icons/images-solid'
import {
  copyAgentImageToClipboard,
  downloadAgentImage,
  isAgentImageMediaSavePending,
  saveAgentImageToMedia,
} from './agentImageActions'
import type { AgentImageMenuRequest } from './agentImageTypes'

interface AgentImageContextMenuProps {
  request: AgentImageMenuRequest
  onClose(): void
}

export function AgentImageContextMenu({ request, onClose }: AgentImageContextMenuProps) {
  const firstItemRef = useRef<HTMLButtonElement>(null)
  const canSave = canWriteMedia(useAuthenticatedAdminUser())
  const mediaSavePending = isAgentImageMediaSavePending(request.image)
  const clipboard = Reflect.get(navigator, 'clipboard') as Clipboard | undefined
  const canCopy = Boolean(clipboard?.write && typeof ClipboardItem !== 'undefined')

  useEffect(() => {
    firstItemRef.current?.focus()
  }, [])

  async function runAction(
    action: 'copy' | 'download' | 'media',
    operation: () => Promise<void>,
  ): Promise<void> {
    onClose()
    try {
      await operation()
      if (action === 'copy') {
        pushToast({ kind: 'success', title: 'Image copied' })
      }
    } catch (err) {
      console.error(`[AgentImageContextMenu] ${action} failed:`, err)
      const fallback = action === 'copy'
        ? 'The image could not be copied.'
        : action === 'download'
          ? 'The image could not be downloaded.'
          : 'The image could not be saved to Media.'
      pushToast({
        kind: 'error',
        title: action === 'copy'
          ? "Couldn't copy image"
          : action === 'download'
            ? "Couldn't save image"
            : "Couldn't save to Media",
        body: getErrorMessage(err, fallback),
      })
    }
  }

  return (
    <ContextMenu
      x={request.x}
      y={request.y}
      ariaLabel="Image actions"
      width={188}
      animateExit
      onClose={onClose}
    >
      <ContextMenuItem
        ref={firstItemRef}
        disabled={!canCopy}
        tooltip={!canCopy ? 'Image copying is not supported by this browser' : undefined}
        onClick={() => {
          void runAction('copy', () => copyAgentImageToClipboard(request.image))
        }}
      >
        <span aria-hidden="true"><CopySolidIcon size={13} /></span>
        Copy image
      </ContextMenuItem>
      <ContextMenuItem
        onClick={() => {
          void runAction('download', () => downloadAgentImage(request.image))
        }}
      >
        <span aria-hidden="true"><ArrowDownIcon size={13} /></span>
        Save to desktop
      </ContextMenuItem>
      <ContextMenuItem
        disabled={!canSave || mediaSavePending}
        tooltip={!canSave
          ? 'Requires permission to upload media'
          : mediaSavePending
            ? 'This image is already being saved to Media'
            : undefined}
        onClick={() => {
          void runAction('media', async () => {
            const asset = await saveAgentImageToMedia(request.image)
            pushToast({ kind: 'success', title: 'Saved to Media', body: asset.filename })
          })
        }}
      >
        <span aria-hidden="true"><ImagesSolidIcon size={13} /></span>
        Save to Media
      </ContextMenuItem>
    </ContextMenu>
  )
}
