/**
 * base.svg editor preview component.
 *
 * Renders the sanitised inline SVG into the canvas so WYSIWYG matches the
 * published output. The markup is sanitised here too (never trust that the
 * Properties panel already did it) before being injected.
 *
 * Component-only file so React Fast Refresh can hot-patch edits without
 * re-running module registration.
 */
import React from 'react'
import type { ModuleComponentProps } from '@core/module-engine'
import { sanitizeSvg } from '@core/sanitize'
import { CanvasModulePlaceholder } from '@ui/components/CanvasModulePlaceholder'
import { cn } from '@ui/cn'
import { ImageSolidIcon } from 'pixel-art-icons/icons/image-solid'
import type { SvgStoredProps } from './props'
import { parseSvgCanvasRoot } from './svgCanvasRoot'

export const SvgEditor: React.FC<ModuleComponentProps<SvgStoredProps>> = ({
  props,
  mcClassName,
  nodeWrapperProps,
}) => {
  const markup = sanitizeSvg(props.svg)
  const svgRoot = markup ? parseSvgCanvasRoot(markup) : null

  if (!svgRoot) {
    return (
      <CanvasModulePlaceholder
        {...nodeWrapperProps}
        className={mcClassName}
        icon={<ImageSolidIcon size={20} aria-hidden="true" />}
        label="No SVG"
      />
    )
  }

  const label = String(props.title ?? '').trim()
  const { style: nodeStyle, ...editorRootProps } = nodeWrapperProps ?? {}
  const mergedStyle = svgRoot.style || nodeStyle
    ? { ...svgRoot.style, ...nodeStyle }
    : undefined

  return React.createElement('svg', {
    ...svgRoot.attributes,
    ...editorRootProps,
    className: cn(mcClassName, svgRoot.className) || undefined,
    style: mergedStyle,
    ...(label ? { role: 'img', 'aria-label': label } : {}),
    dangerouslySetInnerHTML: { __html: svgRoot.innerHtml },
  })
}
