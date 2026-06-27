/**
 * SeoToolbar — the SEO workspace's toolbar publish controls, rendered into
 * AdminPageLayout's `toolbarRightSlot`. Same PublishActionGroup the Site and
 * Content workspaces use: status dot + split publish button + actions menu
 * (Save draft / Open live URL), driven by whichever editor currently owns
 * the save bridge.
 */
import { CheckIcon } from 'pixel-art-icons/icons/check'
import { CircleAlertSolidIcon } from 'pixel-art-icons/icons/circle-alert-solid'
import { ExternalLinkSolidIcon } from 'pixel-art-icons/icons/external-link-solid'
import { LoaderIcon } from 'pixel-art-icons/icons/loader'
import { SaveSolidIcon } from 'pixel-art-icons/icons/save-solid'
import { SendSolidIcon } from 'pixel-art-icons/icons/send-solid'
import type { IconComponent } from 'pixel-art-icons/types'
import {
  PublishActionGroup,
  type PublishActionMenuItem,
  type PublishActionStatusTone,
} from '@site/toolbar/PublishActionGroup'
import type { SeoSaveStatus } from '../hooks/useSeoSaveBridge'

interface SeoToolbarProps {
  status: SeoSaveStatus | null
  onSave: () => void
  onPublish: () => void
}

interface ToolbarViewState {
  statusText: string | null
  statusTone: PublishActionStatusTone
  publishLabel: string
  PublishIcon: IconComponent
  publishState: 'idle' | 'busy' | 'success' | 'error'
}

function deriveViewState(status: SeoSaveStatus): ToolbarViewState {
  const { state, dirty } = status
  if (state === 'publishing') {
    return { statusText: 'Publishing', statusTone: 'neutral', publishLabel: 'Publishing', PublishIcon: LoaderIcon, publishState: 'busy' }
  }
  if (state === 'saving') {
    return { statusText: 'Saving draft', statusTone: 'neutral', publishLabel: 'Publish', PublishIcon: SendSolidIcon, publishState: 'idle' }
  }
  if (state === 'error') {
    return { statusText: 'Failed — details in the editor', statusTone: 'danger', publishLabel: 'Retry publish', PublishIcon: CircleAlertSolidIcon, publishState: 'error' }
  }
  if (dirty) {
    return { statusText: 'Unsaved changes', statusTone: 'warning', publishLabel: 'Save & publish', PublishIcon: SendSolidIcon, publishState: 'idle' }
  }
  if (state === 'published') {
    return { statusText: 'Published — live', statusTone: 'success', publishLabel: 'Published', PublishIcon: CheckIcon, publishState: 'success' }
  }
  if (state === 'saved') {
    return { statusText: 'Saved — goes live on publish', statusTone: 'success', publishLabel: 'Publish', PublishIcon: SendSolidIcon, publishState: 'idle' }
  }
  return { statusText: null, statusTone: 'neutral', publishLabel: 'Publish', PublishIcon: SendSolidIcon, publishState: 'idle' }
}

export function SeoToolbar({ status, onSave, onPublish }: SeoToolbarProps) {
  if (!status) return null

  const { statusText, statusTone, publishLabel, PublishIcon, publishState } = deriveViewState(status)
  const busy = status.state === 'saving' || status.state === 'publishing'
  const cleanPublished = status.state === 'published' && !status.dirty

  const publishTitle = !status.canSave
    ? 'Your role does not include Manage SEO'
    : !status.canPublish
      ? 'Your role does not include publish permissions'
      : status.publishScope === 'site'
        ? 'Publishes the whole site draft — same as the Site toolbar'
        : 'Saves and publishes this entry'

  const menuItems: PublishActionMenuItem[] = [
    {
      id: 'save-draft',
      label: 'Save draft',
      icon: SaveSolidIcon,
      disabled: !status.canSave || !status.dirty || busy,
      onSelect: onSave,
      testId: 'toolbar-seo-save-draft',
    },
    {
      id: 'open-live',
      label: 'Open live URL',
      icon: ExternalLinkSolidIcon,
      disabled: !status.liveUrl,
      onSelect: () => {
        if (!status.liveUrl) return
        window.open(status.liveUrl, '_blank', 'noopener,noreferrer')
      },
      testId: 'toolbar-seo-open-live',
    },
  ]

  return (
    <PublishActionGroup
      statusLabel={statusText}
      statusTone={statusTone}
      publishLabel={publishLabel}
      publishAriaLabel={cleanPublished ? 'Published' : 'Publish SEO changes'}
      publishTitle={publishTitle}
      publishState={publishState}
      publishBusy={status.state === 'publishing'}
      publishDisabled={!status.canSave || !status.canPublish || busy || cleanPublished}
      publishIcon={PublishIcon}
      onPublish={onPublish}
      menuItems={menuItems}
    />
  )
}
