/**
 * useDraftModulePackPreview — session-local `Preview in canvas` for site
 * plugin module drafts.
 *
 * When the site editor opens with `?previewSitePlugin=<localId>` (set by
 * the Plugin IDE), this hook fetches the draft's validate-only module
 * bundle from the preview-pack route (no server-side registration, no
 * plugin row change), activates it through the SAME browser-side pack
 * loader installed plugins use, and marks the modules `Draft` in the
 * inserter. Production and other sessions are untouched; leaving the page
 * (or dropping the param) deactivates the draft pack and re-runs the
 * normal plugin activation pass so the ACTIVE revision's modules return.
 */
import { useEffect } from 'react'
import { parsePluginManifest } from '@core/plugins/manifest'
import {
  activatePluginModulePack,
  deactivatePluginModulePack,
  listPluginRegisteredModuleIds,
} from '@core/plugins/modulePackLoader'
import { PLUGIN_API_VERSION } from '@core/plugin-sdk'
import { SITE_PLUGIN_LOCAL_ID_PATTERN, sitePluginIdFromLocalId } from '@core/site-plugins'
import { pushToast } from '@ui/components/Toast'
import { getErrorMessage } from '@core/utils/errorMessage'
import { useLocation } from '@admin/lib/routing'
import { ensurePluginRuntime } from '@admin/pluginRuntimeBootstrap'
import { notifyCmsPluginsChanged } from '@plugins/utils/pluginEvents'
import { editorPluginModuleComponentFactory } from '@site/canvas/pluginModuleComponentFactory'
import {
  clearDraftPreviewModules,
  markDraftPreviewModules,
} from './draftModulePreviewState'

function previewParam(search: string): string | null {
  const value = new URLSearchParams(search).get('previewSitePlugin')
  if (!value || !SITE_PLUGIN_LOCAL_ID_PATTERN.test(value)) return null
  return value
}

export function useDraftModulePackPreview(): void {
  const { search } = useLocation()
  const localId = previewParam(search)

  useEffect(() => {
    if (!localId) return undefined
    const pluginId = sitePluginIdFromLocalId(localId)
    let cancelled = false
    let registered: string[] = []

    async function loadDraftPack(): Promise<void> {
      // The pack bundle inlines the SDK, but its React components render
      // through the host runtime — make sure it exists first.
      await ensurePluginRuntime()
      if (cancelled) return
      // Vite must not try to resolve this at build time — it is a live
      // server route that rebuilds the draft on every request (no-store).
      const url = `/admin/api/cms/site-plugins/${localId}/preview-pack.js?t=${Date.now()}`
      const mod = (await import(/* @vite-ignore */ url)) as {
        default: unknown
      }
      if (cancelled) return

      // A synthetic manifest for the DRAFT pack: modules.register is
      // "granted" browser-side only — the pack never leaves this session.
      const manifest = parsePluginManifest({
        id: pluginId,
        name: `${localId} (draft preview)`,
        version: '0.0.1-draft',
        apiVersion: PLUGIN_API_VERSION,
        permissions: ['modules.register'],
        grantedPermissions: ['modules.register'],
        resources: [],
        adminPages: [],
      })
      activatePluginModulePack(
        manifest,
        mod as Parameters<typeof activatePluginModulePack>[1],
        editorPluginModuleComponentFactory,
      )
      registered = listPluginRegisteredModuleIds(pluginId)
      markDraftPreviewModules(registered)
      pushToast({
        kind: 'info',
        title: `Previewing “${localId}” draft modules`,
        body: 'Session-local: production and other editors are unaffected.',
      })
    }

    void loadDraftPack().catch((err: unknown) => {
      if (cancelled) return
      pushToast({
        kind: 'error',
        title: 'Draft preview failed',
        body: getErrorMessage(err, 'Could not build the draft module pack'),
      })
    })

    return () => {
      cancelled = true
      clearDraftPreviewModules(registered)
      deactivatePluginModulePack(pluginId)
      // Restore the ACTIVE revision's registrations (if any) — the normal
      // activation pass is idempotent and reads server state.
      notifyCmsPluginsChanged()
    }
  }, [localId])
}
