/**
 * VM-boundary permission enforcement.
 *
 * There are three permission-check sites with the SAME authority:
 *   1. VM-side `assertPermission` (in the QuickJS bootstrap)
 *   2. Host-side `assertHostPluginPermission` (server/plugins/host/registry.ts)
 *   3. Editor-side `assertPluginPermission` (src/core/plugins/runtime.ts)
 *
 * All three validate against the AUTHORITATIVE granted-permission set
 * (`manifest.grantedPermissions`), NOT the declared `permissions` array. These
 * tests pin the VM-side guarantee specifically: a permission a plugin DECLARES
 * but was NOT granted is denied AT THE VM BOUNDARY — the synchronous throw
 * happens inside the sandbox before any host dispatch is even attempted, so the
 * host-side backstop is never reached. A granted permission, by contrast, works
 * end-to-end through the regenerated bootstrap.
 *
 * These run the VM directly (not through the install flow) so the assertion is
 * unambiguously about the VM layer and not the host's lifecycle wrapping.
 */
import { describe, expect, it } from 'bun:test'
import { createPluginVm } from '../../../server/plugins/quickjs/vm'

interface RecordedCall {
  target: string
  args: unknown[]
}

/**
 * A plugin whose `activate` hook registers a hook listener — which requires the
 * `cms.hooks` permission. `grantedPermissions` is varied per test.
 */
const HOOK_PLUGIN_SOURCE = `
  ;(function () {
    const __plugin_exports = (globalThis.__plugin_exports = {});
    __plugin_exports.activate = async function activate(api) {
      // Awaited so the host-call deferred settles before activate returns —
      // keeps VM teardown clean. The permission check throws synchronously
      // BEFORE this point when cms.hooks is not granted.
      await api.cms.hooks.on('some.event', function () {});
    };
  })();
`

describe('VM-side permission enforcement', () => {
  it('DENIES a declared-but-not-granted permission at the VM boundary (host never reached)', async () => {
    const calls: RecordedCall[] = []
    const vm = await createPluginVm({
      pluginSource: HOOK_PLUGIN_SOURCE,
      env: {
        pluginId: 'acme.denied',
        manifestVersion: '1.0.0',
        // The manifest may DECLARE `cms.hooks`, but the operator did NOT grant
        // it — only `cms.routes` is in the granted set the host wires in.
        grantedPermissions: ['cms.routes'],
        assetBasePath: '/uploads/plugins/acme.denied/1.0.0',
        settings: {},
        hostCall: async (target, args) => {
          calls.push({ target, args })
          return null
        },
        log: () => {},
      },
    })
    try {
      // The bootstrap's assertPermission throws synchronously inside activate.
      await expect(vm.runLifecycle('activate')).rejects.toThrow(
        /requires permission "cms\.hooks"/,
      )
      // Proof it was denied at the VM, not the host: the host dispatcher was
      // never invoked for the hook registration (the throw short-circuited
      // before any `__hostCall`).
      expect(calls.find((c) => c.target === 'cms.hooks.on')).toBeUndefined()
    } finally {
      vm.dispose()
    }
  })

  it('ALLOWS a granted permission end-to-end through the regenerated bootstrap', async () => {
    const calls: RecordedCall[] = []
    const vm = await createPluginVm({
      pluginSource: HOOK_PLUGIN_SOURCE,
      env: {
        pluginId: 'acme.granted',
        manifestVersion: '1.0.0',
        grantedPermissions: ['cms.hooks'],
        assetBasePath: '/uploads/plugins/acme.granted/1.0.0',
        settings: {},
        hostCall: async (target, args) => {
          calls.push({ target, args })
          return null
        },
        log: () => {},
      },
    })
    try {
      // Lifecycle runs, the api call passes the VM permission gate, and the
      // hook registration reaches the host dispatcher.
      await vm.runLifecycle('activate')
      const registration = calls.find((c) => c.target === 'cms.hooks.on')
      expect(registration).toBeDefined()
      expect(registration?.args?.[0]).toMatchObject({ event: 'some.event' })
    } finally {
      vm.dispose()
    }
  })

  it('exposes the GRANTED set (not the declared set) via api.plugin.permissions', async () => {
    const calls: RecordedCall[] = []
    const vm = await createPluginVm({
      pluginSource: `
        ;(function () {
          const __plugin_exports = (globalThis.__plugin_exports = {});
          __plugin_exports.activate = async function activate(api) {
            await api.cms.hooks.emit('perms.observed', api.plugin.permissions.slice().sort());
          };
        })();
      `,
      env: {
        pluginId: 'acme.perms',
        manifestVersion: '1.0.0',
        grantedPermissions: ['cms.hooks', 'cms.routes'],
        assetBasePath: '/uploads/plugins/acme.perms/1.0.0',
        settings: {},
        hostCall: async (target, args) => {
          calls.push({ target, args })
          return null
        },
        log: () => {},
      },
    })
    try {
      await vm.runLifecycle('activate')
      const emit = calls.find((c) => c.target === 'cms.hooks.emit')
      expect(emit).toBeDefined()
      // `api.plugin.permissions` mirrors the authoritative granted set.
      // The VM sends the RAW name — namespacing to `plugin.<id>.*` is the
      // host dispatcher's job (canonicalPluginEventName in handleHooksEmit).
      expect(emit?.args?.[0]).toMatchObject({
        event: 'perms.observed',
        payload: ['cms.hooks', 'cms.routes'],
      })
    } finally {
      vm.dispose()
    }
  })
})
