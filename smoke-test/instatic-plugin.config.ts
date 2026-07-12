import { definePlugin, permissions } from '@core/plugin-sdk'
import hello from './modules/hello'

export default definePlugin({
  id: 'local.smoke-test',
  name: 'Smoke Test',
  version: '0.1.0',
  description: 'A new Smoke Test plugin.',
  permissions: [permissions.modulesRegister],
  modules: [hello],
  // Add settings, admin pages, hooks, frontend bundles, or a Visual Component
  // pack here as your plugin grows. See docs/features/plugin-system.md for the
  // full SDK surface.
})
