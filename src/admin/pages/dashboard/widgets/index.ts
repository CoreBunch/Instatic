/**
 * First-party dashboard widget bootstrap.
 *
 * Importing this file registers every built-in dashboard widget against
 * `dashboardWidgetRegistry`. The DashboardPage imports it once on mount
 * — subsequent navigations are cheap because the registrations stick.
 *
 * Plugin-registered widgets land separately via
 * `api.dashboard.widgets.register(...)` and don't need to be re-listed
 * here.
 */
import { ActivityWidget } from './ActivityWidget'
import { AiUsageWidget } from './AiUsageWidget'
import { DomainWidget } from './DomainWidget'
import { MediaWidget } from './MediaWidget'
import { MembersWidget } from './MembersWidget'
import { PagesWidget } from './PagesWidget'
import { PluginsWidget } from './PluginsWidget'
import { PostsWidget } from './PostsWidget'
import { PublishQueueWidget } from './PublishQueueWidget'
import { StatusWidget } from './StatusWidget'
import { StorageWidget } from './StorageWidget'

import { dashboardWidgetRegistry } from '@core/dashboard'

import { DashboardSolidIcon } from 'pixel-art-icons/icons/dashboard-solid'
import { CloudUploadSolidIcon } from 'pixel-art-icons/icons/cloud-upload-solid'
import { DatabaseSolidIcon } from 'pixel-art-icons/icons/database-solid'
import { FileTextSolidIcon } from 'pixel-art-icons/icons/file-text-solid'
import { GlobeSolidIcon } from 'pixel-art-icons/icons/globe-solid'
import { ImageSolidIcon } from 'pixel-art-icons/icons/image-solid'
import { PenSquareSolidIcon } from 'pixel-art-icons/icons/pen-square-solid'
import { PlugSolidIcon } from 'pixel-art-icons/icons/plug-solid'
import { UsersSolidIcon } from 'pixel-art-icons/icons/users-solid'
import { ZapSolidIcon } from 'pixel-art-icons/icons/zap-solid'

/**
 * One-shot guard so re-importing this module (HMR, tests, lazy mounts)
 * doesn't double-register. The registry's `register` would replace the
 * existing definition by id anyway, but skipping the work shortens the
 * dev-reload tick noticeably.
 */
let registered = false

export function registerFirstPartyDashboardWidgets(): void {
  if (registered) return
  registered = true

  // NOTE: the Visitors widget is no longer registered first-party. A plugin
  // can register its own dashboard tile via `api.dashboard.widgets.register(...)`.
  // The host stays widget-agnostic — installing a plugin is what puts an extra
  // tile on the dashboard.

  dashboardWidgetRegistry.register({
    id: 'pages',
    ownerId: 'core',
    name: 'Pages',
    description: 'Published + drafts',
    icon: FileTextSolidIcon,
    defaultSize: 3,
    tint: 'lilac',
    render: PagesWidget,
  })

  dashboardWidgetRegistry.register({
    id: 'posts',
    ownerId: 'core',
    name: 'Posts',
    description: 'Posts by category',
    icon: PenSquareSolidIcon,
    defaultSize: 3,
    tint: 'peach',
    render: PostsWidget,
  })

  // ──────────────────────────────────────────────────────────────────
  // DELIBERATE FORK DIVERGENCE — Members widget (membership fork).
  //
  // Upstream Instatic DELIBERATELY removed first-party visitor / analytics
  // dashboard widgets (see the "Visitors widget is no longer registered
  // first-party" note above — a plugin is expected to register its own).
  // This is a MEMBERSHIP-focused fork, where a first-party "Members"
  // count widget is CORE PRODUCT, not generic analytics, so it is
  // registered first-party instead of being left to a plugin.
  //
  // If a future upstream rebase drops this block, treat the removal as a
  // DECISION POINT, not a silent regression — re-confirm against the
  // fork's membership direction before deleting. Mirrors PostsWidget
  // (count + 28-day registration histogram from visitor_users.created_at).
  // ──────────────────────────────────────────────────────────────────
  dashboardWidgetRegistry.register({
    id: 'members',
    ownerId: 'core',
    name: 'Members',
    description: 'Registered visitors',
    icon: UsersSolidIcon,
    defaultSize: 3,
    tint: 'mint',
    render: MembersWidget,
  })

  dashboardWidgetRegistry.register({
    id: 'storage',
    ownerId: 'core',
    name: 'Storage',
    description: 'Disk usage breakdown',
    icon: DatabaseSolidIcon,
    defaultSize: 6,
    tint: 'sky',
    render: StorageWidget,
  })

  // The Top Pages widget also ships from the Analytics plugin (see the
  // Visitors note above). Same rationale — installing the Analytics
  // plugin is what surfaces the most-viewed-URLs tile.

  dashboardWidgetRegistry.register({
    id: 'activity',
    ownerId: 'core',
    name: 'Activity',
    description: 'Recent edits & publishes',
    icon: DashboardSolidIcon,
    defaultSize: 4,
    tint: 'peach',
    render: ActivityWidget,
  })

  dashboardWidgetRegistry.register({
    // `id: 'publish'` is preserved as a stable identifier so existing
    // saved dashboard layouts keep finding this widget. The display
    // label is "Publish lineup" — the block-library + widget chrome
    // both read this `name`, so users see the new label everywhere.
    id: 'publish',
    ownerId: 'core',
    name: 'Publish lineup',
    description: 'Scheduled, recently published, and drafts',
    icon: CloudUploadSolidIcon,
    defaultSize: 4,
    tint: 'sky',
    render: PublishQueueWidget,
  })

  dashboardWidgetRegistry.register({
    id: 'plugins',
    ownerId: 'core',
    name: 'Plugins',
    description: 'Installed & updates',
    icon: PlugSolidIcon,
    defaultSize: 4,
    tint: 'mint',
    render: PluginsWidget,
  })

  dashboardWidgetRegistry.register({
    id: 'media',
    ownerId: 'core',
    name: 'Media',
    description: 'Files & thumbnails',
    icon: ImageSolidIcon,
    defaultSize: 3,
    tint: 'peach',
    render: MediaWidget,
  })

  dashboardWidgetRegistry.register({
    id: 'status',
    ownerId: 'core',
    name: 'Site status',
    description: 'Uptime, builds, backups',
    icon: ZapSolidIcon,
    defaultSize: 3,
    tint: 'mint',
    render: StatusWidget,
  })

  dashboardWidgetRegistry.register({
    id: 'domain',
    ownerId: 'core',
    name: 'Domain',
    description: 'DNS + SSL status',
    icon: GlobeSolidIcon,
    defaultSize: 3,
    tint: 'sky',
    render: DomainWidget,
  })

  dashboardWidgetRegistry.register({
    id: 'ai-usage',
    ownerId: 'core',
    name: 'AI usage',
    description: 'Spend + chats this month',
    icon: ZapSolidIcon,
    defaultSize: 3,
    tint: 'lilac',
    render: AiUsageWidget,
  })
}
