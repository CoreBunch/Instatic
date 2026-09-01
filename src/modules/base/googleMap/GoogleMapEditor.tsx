import React from 'react'
import type { ModuleComponentProps } from '@core/module-engine'
import { CanvasModulePlaceholder } from '@ui/components/CanvasModulePlaceholder'
import { GlobeSolidIcon } from 'pixel-art-icons/icons/globe-solid'
import { cn } from '@ui/cn'
import type { GoogleMapStoredProps } from './props'
import { googleMapsEmbedUrl } from './url'
import styles from './GoogleMapEditor.module.css'

/** Canvas counterpart of the published map iframe. */
export const GoogleMapEditor: React.FC<ModuleComponentProps<GoogleMapStoredProps>> = ({
  props,
  mcClassName,
  nodeWrapperProps,
}) => {
  const embedUrl = googleMapsEmbedUrl(props.embedUrl)
  if (!embedUrl) {
    return (
      <CanvasModulePlaceholder
        {...nodeWrapperProps}
        className={mcClassName}
        icon={<GlobeSolidIcon size={32} />}
        label="Add an official Google Maps Embed URL"
        layout="row"
      />
    )
  }

  return (
    <div {...nodeWrapperProps} className={cn(mcClassName, styles.shell)}>
      <iframe
        className={styles.frame}
        src={embedUrl}
        title={props.title || 'Google Maps location'}
        loading="lazy"
        referrerPolicy="strict-origin-when-cross-origin"
        allowFullScreen
      />
    </div>
  )
}
