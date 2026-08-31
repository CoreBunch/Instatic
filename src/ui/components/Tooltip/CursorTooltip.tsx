import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@ui/cn'
import { clamp } from '@ui/lib/clamp'
import { ensurePortalRoot } from '@ui/lib/portalRoot'
import { TOOLTIP_ROOT_ID } from './Tooltip'
import styles from './Tooltip.module.css'

export interface CursorTooltipPoint {
  x: number
  y: number
}

interface CursorTooltipProps {
  content: ReactNode
  point: CursorTooltipPoint | null
  offset?: number
}

const DEFAULT_CURSOR_OFFSET = 12
const VIEWPORT_MARGIN = 8

export function CursorTooltip({
  content,
  point,
  offset = DEFAULT_CURSOR_OFFSET,
}: CursorTooltipProps) {
  const id = useId()
  const bubbleRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<CursorTooltipPoint | null>(null)
  const pointX = point?.x
  const pointY = point?.y

  useLayoutEffect(() => {
    if (pointX === undefined || pointY === undefined || !bubbleRef.current) {
      setPosition(null)
      return
    }

    const bubbleRect = bubbleRef.current.getBoundingClientRect()
    setPosition({
      x: clamp(pointX + offset, VIEWPORT_MARGIN, window.innerWidth - bubbleRect.width - VIEWPORT_MARGIN),
      y: clamp(pointY + offset, VIEWPORT_MARGIN, window.innerHeight - bubbleRect.height - VIEWPORT_MARGIN),
    })
  }, [pointX, pointY, offset])

  if (!point) return null

  const resolvedPosition = position ?? {
    x: point.x + offset,
    y: point.y + offset,
  }
  const bubbleStyle = {
    '--tooltip-x': `${resolvedPosition.x}px`,
    '--tooltip-y': `${resolvedPosition.y}px`,
    '--tooltip-arrow-offset': '0px',
  } as CSSProperties

  return createPortal(
    <div
      ref={bubbleRef}
      id={id}
      role="tooltip"
      className={cn(styles.bubble, styles.visible)}
      data-side="cursor"
      style={bubbleStyle}
    >
      {content}
    </div>,
    ensurePortalRoot(TOOLTIP_ROOT_ID),
  )
}
