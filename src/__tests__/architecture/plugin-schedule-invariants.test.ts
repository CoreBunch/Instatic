/**
 * Architecture gates for plugin scheduled jobs.
 *
 * The scheduler engine sits inside the same Bun/Node host process as the
 * rest of the CMS, but it dispatches to plugin code only through the
 * existing sandboxed worker protocol. These tests lock in the invariants
 * that keep the boundary real: if any of them fail, plugin schedule
 * handlers could escape the sandbox or bypass permission gates.
 */
import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

async function read(relative: string): Promise<string> {
  return await readFile(join(ROOT, relative), 'utf-8')
}

describe('plugin schedule invariants', () => {
  it('scheduler dispatches to the worker via runScheduleInWorker (not direct invocation)', async () => {
    const source = await read('server/plugins/scheduler.ts')
    expect(source).toContain("import { runScheduleInWorker } from './host/rpc'")
    // No raw `await import(...)` of plugin code at runtime — schedules
    // are dispatched through the protocol like every other plugin call.
    expect(source).not.toMatch(/await\s+import\s*\(\s*[`'"][./]/)
  })

  it('cms.schedule.register / cancel api targets are gated by the cms.schedule permission', async () => {
    const dispatchSource = await read('server/plugins/host/apiDispatch.ts')
    const targetsSource = await read('server/plugins/protocol/targets.ts')
    // Both dispatch table entries must be present in apiDispatch.ts.
    expect(dispatchSource).toContain("'cms.schedule.register':")
    expect(dispatchSource).toContain("'cms.schedule.cancel':")
    // Permission enforcement is centralized: apiDispatch asserts the required
    // permission before any handler runs, and both schedule targets are paired
    // with 'cms.schedule' in the single TARGET_PERMISSIONS map.
    expect(dispatchSource).toContain('assertHostPluginPermission(entry, requiredPermission)')
    expect(targetsSource).toContain("'cms.schedule.register': 'cms.schedule'")
    expect(targetsSource).toContain("'cms.schedule.cancel': 'cms.schedule'")
  })

  it('schedule handler storage lives inside the VM, not on the host', async () => {
    const apiSource = await read('server/plugins/quickjs/bootstrap/src/pluginRuntime.ts')
    const vmSource = await read('server/plugins/quickjs/vm.ts')
    // The bootstrap registers `__plugin_handlers.schedules` (in-VM map).
    // The host has metadata only — never the function itself.
    expect(apiSource).toContain('globalThis.__plugin_handlers')
    expect(apiSource).toContain('schedules: {}')
    expect(apiSource).toContain('globalThis.__runSchedule')
    // Schedule handlers cross the boundary by ID through the bootstrap's
    // __runSchedule dispatcher (a persistent handle to the BOOTSTRAP
    // function, grabbed before plugin code evaluates) — the host never
    // holds a handle to the plugin's own handler function.
    expect(vmSource).toContain("callVoid(ctx, dispatcher('__runSchedule'), [scheduleId]")
  })

  it('the schedule register schema rejects unsupported cadence intervals', async () => {
    // The cadence validator must not be permissive — only the five
    // documented intervals are allowed. If anyone adds an unbounded
    // string cadence (full cron, etc.) without updating the schema,
    // this test will catch them.
    const source = await read('server/plugins/protocol/schemas/schedule.ts')
    expect(source).toContain('const CadenceSchema = Type.Union(')
    expect(source).toContain("Type.Literal('hourly')")
    expect(source).toContain("Type.Literal('daily')")
    expect(source).toContain("Type.Literal('weekly')")
    expect(source).toContain("Type.Literal('monthly')")
    expect(source).toContain("Type.Literal('every')")
  })

  it('the schedule register schema caps maxDurationMs', async () => {
    const source = await read('server/plugins/protocol/schemas/schedule.ts')
    // 5 * 60_000 = 5 minutes — the hard host-side cap so a plugin can't
    // pin a worker indefinitely.
    expect(source).toContain('maxDurationMs: Type.Integer({ minimum: 100, maximum: 5 * 60_000 })')
  })

  it('register and cancel share the single schedule-id namespacing helper', async () => {
    // Registration stores rows under `<pluginId>.<localId>`. If cancel ever
    // stops running the caller-supplied id through the same helper it will
    // match no row and the schedule fires forever.
    const registration = await read('server/plugins/pluginScheduleRegistration.ts')
    const cancelHandler = await read('server/plugins/host/handlers/schedule.ts')
    expect(registration).toContain('export function pluginScheduleFullId(')
    expect(registration).toContain('pluginScheduleFullId(reg.pluginId, reg.scheduleId)')
    expect(cancelHandler).toContain('pluginScheduleFullId(msg.pluginId, scheduleId)')
  })

  it('activation runs the schedule ghost sweep', async () => {
    // A schedule row whose registration was dropped by a plugin upgrade has
    // no live VM handler — runPluginLifecycle must disable rows that were
    // not re-claimed during the activate pass.
    const runtime = await read('server/plugins/runtime.ts')
    expect(runtime).toContain("if (hook === 'activate')")
    expect(runtime).toContain('disableSchedulesNotReclaimedSince(db, pluginId, startedAtIso)')
  })
})
