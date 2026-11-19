/**
 * Route registration handler — implements the `cms.routes.register` api-call.
 *
 * Validates the tagged `access` discriminator and upserts the route entry
 * into the plugin's host-side route map. Gated by the `cms.routes`
 * permission. Public-access routes additionally require the plugin to hold
 * `cms.routes.public` so the install-time consent dialog can flag the
 * plugin to the operator before they approve it.
 */

import { isCoreCapability } from '../../../auth/capabilities'
import type { ApiCallFor } from '../../protocol/apiCallSchema'
import type { DbClient } from '../../../db/client'
import { assertHostPluginPermission } from '../registry'
import { replyApiOk } from '../apiReplies'
import type { HostPluginRecord, HostRouteAccess } from '../types'

export async function handleRoutesRegister(
  msg: ApiCallFor<'cms.routes.register'>,
  entry: HostPluginRecord,
  _db: DbClient,
): Promise<void> {
  // Base `cms.routes` permission is enforced centrally in apiDispatch.ts (via
  // TARGET_PERMISSIONS). Only the conditional `cms.routes.public` grant for
  // anonymous-callable routes stays here — it can't live in a static map.
  const [arg] = msg.args

  let access: HostRouteAccess
  switch (arg.access.kind) {
    case 'capability':
      if (!isCoreCapability(arg.access.capability)) {
        throw new Error(`Unknown plugin route capability: ${arg.access.capability}`)
      }
      access = { kind: 'capability', capability: arg.access.capability }
      break
    case 'authenticated':
      access = { kind: 'authenticated' }
      break
    case 'public':
      // Public-access routes require an additional permission so the
      // install consent flow surfaces "this plugin will register
      // anonymously-callable endpoints" to the operator. Without this,
      // a stolen permission grant could quietly mint a webhook the
      // plugin author never disclosed in the install dialog.
      assertHostPluginPermission(entry, 'cms.routes.public')
      access = { kind: 'public' }
      break
    case 'member': {
      // A member route hands the plugin the signed-in member, so it needs
      // the same grant as reading a member does.
      assertHostPluginPermission(entry, 'members.read')
      // A route can only be opened to apps under a scope the manifest
      // declared: that is what the owner saw at install and what the member
      // reads before allowing an app.
      const appScope = arg.access.appScope ?? null
      if (appScope !== null && !(entry.manifest.appScopes ?? []).some((scope) => scope.name === appScope)) {
        throw new Error(`App scope "${appScope}" is not declared in the plugin manifest's appScopes`)
      }
      access = { kind: 'member', tag: arg.access.tag ?? null, appScope }
      break
    }
  }

  entry.routes.set(arg.routeKey, {
    pluginId: msg.pluginId,
    method: arg.method,
    path: arg.path,
    access,
    routeKey: arg.routeKey,
  })
  replyApiOk(msg.pluginId, msg.correlationId)
}
