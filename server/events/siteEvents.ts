/**
 * Site events bus — the in-process fan-out behind the multi-admin live-pull
 * channel (level B of the live-sync plan).
 *
 * Instatic is self-hosted and runs as ONE Bun process by product definition,
 * so an in-memory bus wrapping Bun's native pub/sub is *correct*, not a
 * shortcut — multi-process deployments would need a shared bus and are
 * explicitly out of scope (documented in docs/features/site-shell.md).
 *
 * The publisher is the `Bun.Server` instance, registered at boot
 * (server/index.ts) AFTER `Bun.serve` returns. Until then — and in tests
 * that exercise handlers without a listening server — `publishSiteEvent`
 * drops events silently, which is safe by design: events are idempotent
 * HINTS; the seq-cursor delta on (re)connect is the truth
 * (see @core/persistence/syncEvents).
 */
import type { SiteSyncEvent } from '@core/persistence/syncEvents'

/** The one durable topic every open editor subscribes to. */
export const SITE_EVENTS_TOPIC = 'site'

interface SiteEventPublisher {
  publish(topic: string, data: string): number
}

let publisher: SiteEventPublisher | null = null

/** Register the boot-time publisher (the Bun server). Pass null to detach (tests). */
export function setSiteEventPublisher(next: SiteEventPublisher | null): void {
  publisher = next
}

/** Broadcast one sync event to every subscribed editor socket. */
export function publishSiteEvent(event: SiteSyncEvent): void {
  if (!publisher) return
  publisher.publish(SITE_EVENTS_TOPIC, JSON.stringify(event))
}
