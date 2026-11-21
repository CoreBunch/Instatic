import { useAsyncResource } from '@admin/lib/useAsyncResource'
import type { DashboardWidgetRendererProps } from '@core/dashboard'
import { ApiError } from '@core/http'
import { getCmsPublishStatus } from '@core/persistence'
import { Button } from '@ui/components/Button'
import { Widget } from '@ui/components/Widget'
import { cn } from '@ui/cn'
import { ZapSolidIcon } from 'pixel-art-icons/icons/zap-solid'
import styles from './widgets.module.css'

export function PublishingStatusWidget({ span, editing }: DashboardWidgetRendererProps) {
  const { data, loading, error, refresh } = useAsyncResource(async (signal) => {
    try {
      return { status: await getCmsPublishStatus({ signal }) }
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) return { status: null }
      throw err
    }
  }, [])
  const status = data?.status

  return (
    <Widget
      widgetId="status"
      title="Publishing status"
      icon={ZapSolidIcon}
      tint="mint"
      span={span}
      editing={editing}
      loading={loading}
      action={error && !editing && (
        <Button variant="ghost" size="sm" onClick={refresh}>Retry</Button>
      )}
    >
      {error && <p className={styles.widgetHint} role="status">Couldn’t load publishing status.</p>}
      {status === null && (
        <p className={styles.widgetHint} role="status">You don’t have permission to view publishing status.</p>
      )}
      {status && (
        <>
          <p className={styles.publishState}>
            <span className={cn(styles.dot, status.hasPublishedVersion ? styles.dotGreen : styles.dotMuted)} aria-hidden="true" />
            {status.hasPublishedVersion ? 'Published' : 'Not published'}
          </p>
          {status.hasPublishedVersion && (
            <p className={styles.widgetHint}>
              {status.draftMatchesPublished ? 'Site draft is up to date.' : 'Unpublished site changes.'}
            </p>
          )}
          {status.lastPublishedAt && (
            <p className={styles.widgetHint}>
              Last published{' '}
              <time dateTime={status.lastPublishedAt}>
                {new Date(status.lastPublishedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
              </time>
            </p>
          )}
        </>
      )}
    </Widget>
  )
}
