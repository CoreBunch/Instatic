/**
 * Template plugin — server entrypoint.
 *
 * Lifecycle hooks (install / activate / deactivate / uninstall) let the
 * plugin set up routes, subscribe to CMS events, and run migrations.
 *
 * Requires: cms.routes  (to register backend routes)
 */

export function install(api) {
  api.plugin.log('Template plugin installed')
}

export function activate(api) {
  api.plugin.log('Template plugin activated')

  // Register a simple status route at:
  //   GET /admin/api/cms/plugins/acme.template/runtime/status
  // Requires the cms.routes permission.
  api.cms.routes.get('/status', 'plugins.read', () => ({
    ok: true,
    plugin: api.plugin.id,
    version: api.plugin.version,
  }))

  // Letting an app a site member signed in to call a member route.
  // In plugin.json, declare the scope and request the permissions:
  //
  //   "permissions": ["cms.routes", "members.read"],
  //   "appScopes": [{ "name": "read", "description": "See your saved items" }]
  //
  // (with the TypeScript SDK: `appScopes` in `definePlugin({ ... })`).
  // The member reads the description before allowing the app. Then open a
  // route under that scope; routes without `app` stay closed to apps:
  //
  //   api.cms.routes.member.get('/items', { app: { scope: 'read' } }, (ctx) => ({
  //     member: ctx.member.id,
  //     // { id, name, scope } when an app is calling, null for the member's browser.
  //     app: ctx.app,
  //   }))
}

export function deactivate(api) {
  api.plugin.log('Template plugin deactivated')
}

export function uninstall(api) {
  api.plugin.log('Template plugin uninstalled')
}
