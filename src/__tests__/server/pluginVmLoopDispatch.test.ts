/**
 * VM loop-source dispatch — boundary robustness for `__runLoopFetch` /
 * `__runLoopPreview`.
 *
 * Both dispatchers JSON-marshal their result back to the host. A handler that
 * forgets to return, or (for preview) is mistakenly authored `async`, must not
 * send the JS `undefined` primitive or a Promise across the boundary — the
 * host's `evalString` would throw a cryptic "not a string" or silently parse an
 * empty result. These tests pin the deliberate fallbacks:
 *   - fetch() with no return  → host parses `{ items: [], totalItems: 0 }`
 *   - preview() with no return → host parses `[]`
 *   - preview() that is async  → loud TypeError (preview is contractually sync)
 * and confirm the normal return paths still work end-to-end.
 */
import { describe, expect, it } from 'bun:test'
import { createPluginVm } from '../../../server/plugins/quickjs/vm'
import type { PluginVmEnv } from '../../../server/plugins/quickjs/types'

const LOOP_PLUGIN_SOURCE = `
  ;(function () {
    const __plugin_exports = (globalThis.__plugin_exports = {});
    __plugin_exports.activate = async function activate(api) {
      await api.cms.loops.registerSource({
        id: 'acme.loop.ok',
        label: 'OK',
        fetch: function () { return { items: [{ id: 'a' }], totalItems: 1 }; },
        preview: function () { return [{ id: 'a' }]; },
      });
      await api.cms.loops.registerSource({
        id: 'acme.loop.member',
        label: 'Member',
        perVisitor: true,
        fetch: function (ctx) {
          var member = ctx.request && ctx.request.member;
          return { items: [{ id: member ? member.id : 'nobody', fields: { email: member ? member.email : '' } }], totalItems: 1 };
        },
        preview: function () { return []; },
      });
      await api.cms.loops.registerSource({
        id: 'acme.loop.noreturn',
        label: 'No return',
        fetch: function () { /* author forgot to return */ },
        preview: function () { /* author forgot to return */ },
      });
      await api.cms.loops.registerSource({
        id: 'acme.loop.asyncpreview',
        label: 'Async preview (a bug)',
        fetch: function () { return { items: [], totalItems: 0 }; },
        preview: async function () { return [{ id: 'a' }]; },
      });
    };
  })();
`

async function makeLoopVm() {
  const env: PluginVmEnv = {
    pluginId: 'acme.loop',
    manifestVersion: '1.0.0',
    grantedPermissions: ['loops.register'],
    assetBasePath: '/uploads/plugins/acme.loop/1.0.0',
    settings: {},
    hostCall: async () => null,
    log: () => {},
  }
  const vm = await createPluginVm({ pluginSource: LOOP_PLUGIN_SOURCE, env })
  await vm.runLifecycle('activate')
  return vm
}

describe('VM loop-source dispatch fallbacks', () => {
  it('runLoopFetch: a fetch() with no return resolves to the empty result shape', async () => {
    const vm = await makeLoopVm()
    try {
      const result = await vm.runLoopFetch('acme.loop.noreturn', {})
      expect(result).toEqual({ items: [], totalItems: 0 })
    } finally {
      vm.dispose()
    }
  })

  it('runLoopFetch: a normal return still flows through', async () => {
    const vm = await makeLoopVm()
    try {
      const result = await vm.runLoopFetch('acme.loop.ok', {})
      expect(result).toEqual({ items: [{ id: 'a' }], totalItems: 1 })
    } finally {
      vm.dispose()
    }
  })

  it('runLoopFetch: the signed-in member the host sends arrives on ctx.request.member', async () => {
    const vm = await makeLoopVm()
    try {
      const request = { query: {}, path: '/', slug: null, cookies: {} }
      const member = { id: 'm1', email: 'ada@example.com', tags: ['pro'], profile: { name: 'Ada' } }
      expect(await vm.runLoopFetch('acme.loop.member', { request: { ...request, member } })).toEqual({
        items: [{ id: 'm1', fields: { email: 'ada@example.com' } }],
        totalItems: 1,
      })
      expect(await vm.runLoopFetch('acme.loop.member', { request: { ...request, member: null } })).toEqual({
        items: [{ id: 'nobody', fields: { email: '' } }],
        totalItems: 1,
      })
    } finally {
      vm.dispose()
    }
  })

  it('runLoopPreview: a preview() with no return resolves to an empty array', async () => {
    const vm = await makeLoopVm()
    try {
      const result = await vm.runLoopPreview('acme.loop.noreturn', {})
      expect(result).toEqual([])
    } finally {
      vm.dispose()
    }
  })

  it('runLoopPreview: a normal array return still flows through', async () => {
    const vm = await makeLoopVm()
    try {
      const result = await vm.runLoopPreview('acme.loop.ok', {})
      expect(result).toEqual([{ id: 'a' }])
    } finally {
      vm.dispose()
    }
  })

  it('runLoopPreview: an async preview() throws loudly instead of silently emptying', async () => {
    const vm = await makeLoopVm()
    try {
      await expect(vm.runLoopPreview('acme.loop.asyncpreview', {})).rejects.toThrow(
        /preview\(\) must be synchronous/,
      )
    } finally {
      vm.dispose()
    }
  })
})
