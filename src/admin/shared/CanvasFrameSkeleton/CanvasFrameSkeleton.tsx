import type { CSSProperties } from 'react'
import type { Breakpoint } from '@core/page-tree'
import { Skeleton, SkeletonCircle } from '@ui/components/Skeleton'
import { cn } from '@ui/cn'
import styles from './CanvasFrameSkeleton.module.css'

type FrameStyle = CSSProperties & { '--bp-width': string }

interface CanvasFrameSkeletonProps {
  breakpointId: string
}

interface CanvasFrameSkeletonFrameProps {
  breakpoint: Pick<Breakpoint, 'id' | 'width'>
  dimmed?: boolean
}

export function CanvasFrameSkeletonFrame({
  breakpoint,
  dimmed = false,
}: CanvasFrameSkeletonFrameProps) {
  const frameStyle = { '--bp-width': `${breakpoint.width}px` } as FrameStyle

  return (
    <div
      className={cn(styles.frameWrapper, dimmed && styles.frameWrapperDimmed)}
      data-testid={`canvas-loading-frame-${breakpoint.id}`}
      style={frameStyle}
    >
      <div className={styles.labelRow} aria-hidden="true">
        <Skeleton width="100%" height={28} radius={0} />
      </div>
      <div
        data-breakpoint-id={breakpoint.id}
        className={styles.viewport}
      >
        <CanvasFrameSkeleton breakpointId={breakpoint.id} />
      </div>
    </div>
  )
}

export function CanvasFrameSkeleton({ breakpointId }: CanvasFrameSkeletonProps) {
  return (
    <div
      className={styles.skeleton}
      data-testid={`canvas-frame-skeleton-${breakpointId}`}
      role="status"
      aria-busy="true"
      aria-label={`Loading ${breakpointId} canvas frame`}
    >
      <div className={styles.chrome} aria-hidden="true">
        <SkeletonCircle size={22} />
        <Skeleton width="16%" height={12} />
        <Skeleton width="10%" height={12} />
        <Skeleton width="12%" height={12} />
      </div>
      <div className={styles.hero} aria-hidden="true">
        <Skeleton width="46%" height={30} />
        <Skeleton width="62%" height={13} />
        <Skeleton width="54%" height={13} />
        <div className={styles.actions}>
          <Skeleton width={84} height={28} radius="var(--input-radius)" />
          <Skeleton width={64} height={28} radius="var(--input-radius)" />
        </div>
      </div>
      <div className={styles.grid} aria-hidden="true">
        <Skeleton height={110} radius="var(--radius)" />
        <Skeleton height={110} radius="var(--radius)" />
        <Skeleton height={110} radius="var(--radius)" />
      </div>
      <div className={styles.copy} aria-hidden="true">
        <Skeleton width="58%" height={15} />
        <Skeleton width="82%" height={11} />
        <Skeleton width="74%" height={11} />
        <Skeleton width="68%" height={11} />
      </div>
    </div>
  )
}
