/**
 * Fail-stop on a call budget overrun, through a REAL plugin worker.
 *
 * A handler cannot be cancelled inside the VM: left alone, one that overran
 * its budget resumes when its await returns and acts (writes, calls out)
 * after its caller was told it failed. So the host stops the plugin's worker
 * and starts a fresh one. Proven here end to end:
 *   - the overrunning route answers 504, a sibling route in flight 503 with
 *     `Retry-After`;
 *   - nothing of the old VM reaches the host afterwards: the write the
 *     handler makes after its await never happens, and a timer loop it
 *     started stops;
 *   - the plugin is re-activated and serves again;
 *   - a schedule that overruns its `maxDurationMs` reports `timeout`;
 *   - overruns never park the plugin: the route that keeps overrunning is
 *     held back (503) and the rest of the plugin keeps serving;
 *   - the recovery handler (what the admin's crash events show) is told
 *     which call it was, with no request data;
 *   - a lifecycle call that cannot finish is still handled as a crash;
 *   - a dead upstream is not an overrun: the handler catches the timeouts
 *     and answers normally.
 *
 * The worker, VM, message protocol and teardown are the production ones. The
 * api-call dispatcher is a recorder (no database), and recovery re-loads the
 * same bundle, as the runtime's handler does.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginManifest } from '@core/plugin-sdk'
import { dispatchApiCall } from '../../../server/plugins/host/apiDispatch'
import { replyApiError, replyApiOk } from '../../../server/plugins/host/apiReplies'
import {
  clearPluginCrashCounter,
  isPluginRestarting,
  setCrashRecoveryHandler,
} from '../../../server/plugins/host/crashRecovery'
import { handleRoutesRegister } from '../../../server/plugins/host/handlers/routes'
import { hostPlugins } from '../../../server/plugins/host/registry'
import {
  loadPluginInWorker,
  runLifecycleInWorker,
  runRouteInWorker,
} from '../../../server/plugins/host/rpc'
import { requestFromWorker, resetPluginWorker, setApiCallDispatcher } from '../../../server/plugins/host/workerPool'
import { workers } from '../../../server/plugins/host/workerState'
import type { ApiCallFor } from '../../../server/plugins/protocol/apiCallSchema'

const PLUGIN_ID = 'acme.overrun'
const CALL_BUDGET_MS = 1_500

const SOURCE = `
;(function () {
  const __plugin_exports = (globalThis.__plugin_exports = {});
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  __plugin_exports.activate = async function activate(api) {
    const notes = api.cms.storage.collection('notes');
    api.cms.routes.public.get('/ok', async function () { return { ok: true }; });
    api.cms.routes.public.get('/sibling', async function () { await sleep(1300); return { done: true }; });
    api.cms.routes.public.get('/slow', async function () {
      // A loop the handler leaves running, and a write after its await.
      setInterval(function () { notes.list(); }, 100);
      await sleep(${CALL_BUDGET_MS + 1_000});
      await notes.create({ late: true });
      return { never: true };
    });
    api.cms.routes.public.get('/dead-upstream', async function () {
      const seen = [];
      for (const path of ['/one', '/two']) {
        try { await fetch('https://down.example.com' + path); seen.push('answered'); }
        catch (e) { seen.push(e.name); }
      }
      return { seen: seen };
    });
    api.cms.schedule.every(5, 'stuck', async function () { await sleep(60000); });
  };
})();
`

const BROKEN_ID = 'acme.cannot-start'

const manifest = {
  id: PLUGIN_ID,
  name: 'Overrun',
  version: '1.0.0',
  grantedPermissions: ['cms.routes', 'cms.routes.public', 'cms.storage', 'cms.schedule', 'network.outbound'],
  networkAllowedHosts: ['down.example.com'],
  resources: [{ id: 'notes', title: 'Notes', fields: [] }],
} as unknown as PluginManifest

/** What the recovery handler was told, in order. */
const teardowns: Array<{ pluginId: string; reason: string; cause: string; decision: string }> = []

/** Every host call the plugin made, in order, with when it arrived. */
const calls: Array<{ target: string; at: number }> = []
let dir = ''

async function load(): Promise<void> {
  const result = await loadPluginInWorker({
    manifest,
    entryFileUrl: join(dir, 'index.js'),
    assetRootPath: dir,
    settings: {},
    callBudgetMs: CALL_BUDGET_MS,
  })
  if (!result.ok) throw new Error(result.error ?? 'load failed')
  await runLifecycleInWorker(PLUGIN_ID, 'activate')
}

function get(path: string): Promise<Response> {
  return runRouteInWorker({
    pluginId: PLUGIN_ID,
    method: 'GET',
    path,
    request: new Request(`https://site.example/_instatic/plugins/${PLUGIN_ID}${path}`),
    user: null,
    member: null,
  })
}

/** Wait until `before` has been replaced by a fresh, re-activated worker. */
async function untilRestarted(before: Worker | undefined): Promise<void> {
  const giveUpAt = Date.now() + 20_000
  while (
    workers.get(PLUGIN_ID) === before ||
    isPluginRestarting(PLUGIN_ID) ||
    !hostPlugins.get(PLUGIN_ID)?.routes.has('GET:/ok')
  ) {
    if (Date.now() > giveUpAt) throw new Error('plugin did not recover')
    await new Promise((res) => setTimeout(res, 25))
  }
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'instatic-overrun-'))
  await writeFile(join(dir, 'index.js'), SOURCE)
  setApiCallDispatcher(async (call) => {
    calls.push({ target: call.target, at: Date.now() })
    if (call.target === 'cms.routes.register') {
      const entry = hostPlugins.get(call.pluginId)
      if (!entry) throw new Error('not loaded')
      await handleRoutesRegister(call as ApiCallFor<'cms.routes.register'>, entry, null as never)
      return
    }
    if (call.target === 'network.fetch') {
      // A host that is down: the request runs for its whole timeout.
      const { timeoutMs } = call.args[1] as { timeoutMs: number }
      await new Promise((res) => setTimeout(res, timeoutMs))
      replyApiError(call.pluginId, call.correlationId, 'fetch timed out', 'fetch_timeout')
      return
    }
    replyApiOk(call.pluginId, call.correlationId, call.target === 'cms.storage.list' ? { records: [], totalCount: 0 } : null)
  })
  setCrashRecoveryHandler(async ({ pluginId, reason, cause, decision }) => {
    teardowns.push({ pluginId, reason, cause, decision: decision.kind })
    if (pluginId === PLUGIN_ID) await load()
  })
  await load()
})

afterAll(async () => {
  await resetPluginWorker()
  hostPlugins.delete(PLUGIN_ID)
  hostPlugins.delete(BROKEN_ID)
  clearPluginCrashCounter(PLUGIN_ID)
  clearPluginCrashCounter(BROKEN_ID)
  setApiCallDispatcher(dispatchApiCall)
  setCrashRecoveryHandler(async () => { /* the runtime registers its own on activation */ })
  await rm(dir, { recursive: true, force: true })
})

describe('plugin call overrun: fail-stop through a real worker', () => {
  it('answers 504 and 503, stops the old VM for good, and serves again', async () => {
    expect((await get('/ok')).status).toBe(200)
    const before = workers.get(PLUGIN_ID)

    const slow = get('/slow')
    // In flight when /slow overruns, and well inside its own budget.
    await new Promise((res) => setTimeout(res, 600))
    const sibling = get('/sibling')

    const slowRes = await slow
    expect(slowRes.status).toBe(504)
    expect(await slowRes.json()).toEqual({ error: `Plugin call exceeded its ${CALL_BUDGET_MS / 1000}s time budget` })

    const siblingRes = await sibling
    expect(siblingRes.status).toBe(503)
    expect(siblingRes.headers.get('retry-after')).toBe('2')

    await untilRestarted(before)
    const stoppedAt = Date.now()
    expect((await get('/ok')).status).toBe(200)

    // Past the moment the abandoned handler would have resumed and written.
    await new Promise((res) => setTimeout(res, 1_800))
    expect(calls.some((call) => call.target === 'cms.storage.create')).toBe(false)
    // Its timer loop went with the worker: no tick after the restart.
    expect(calls.filter((call) => call.target === 'cms.storage.list' && call.at > stoppedAt)).toEqual([])
  }, 60_000)

  it('reports a schedule that overruns its maxDurationMs as a timeout, and recovers', async () => {
    const before = workers.get(PLUGIN_ID)
    // Sent on the worker transport itself: other suites in this process mock
    // the scheduler's `runScheduleInWorker` wrapper.
    const run = await requestFromWorker(
      PLUGIN_ID,
      {
        kind: 'run-schedule',
        correlationId: 'overrun-schedule',
        pluginId: PLUGIN_ID,
        scheduleId: `${PLUGIN_ID}.stuck`,
        maxDurationMs: 300,
      },
      'schedule-result',
    )
    expect(run.status).toBe('timeout')
    expect(run.error).toBe('Plugin call exceeded its 0.3s time budget')
    await untilRestarted(before)
    expect((await get('/ok')).status).toBe(200)
  }, 60_000)

  it('a dead upstream gives the handler catchable timeouts and a normal answer, never an overrun', async () => {
    const before = workers.get(PLUGIN_ID)
    const teardownsBefore = teardowns.length
    const res = await get('/dead-upstream')
    expect(res.status).toBe(200)
    // The first request timed out with room to spare; the second had too
    // little time left and was refused without going out. Both were caught.
    expect(await res.json()).toEqual({ seen: ['TimeoutError', 'TimeoutError'] })
    await new Promise((res2) => setTimeout(res2, 100))
    expect(workers.get(PLUGIN_ID)).toBe(before)
    expect(teardowns.length).toBe(teardownsBefore)
  }, 60_000)

  it('holds back the route that keeps overrunning, without parking the plugin', async () => {
    // The first test's overrun of /slow was this route's first; this is its second.
    const before = workers.get(PLUGIN_ID)
    expect((await get('/slow')).status).toBe(504)
    await untilRestarted(before)

    const dispatchesBefore = calls.length
    const held = await get('/slow')
    expect(held.status).toBe(503)
    const retryAfter = Number(held.headers.get('retry-after'))
    expect(retryAfter).toBeGreaterThan(0)
    expect(retryAfter).toBeLessThanOrEqual(15)
    // Refused by the host: the handler never ran, so it made no host call.
    expect(calls.length).toBe(dispatchesBefore)

    // The plugin itself is up: every teardown was a respawn, and it serves.
    expect((await get('/ok')).status).toBe(200)
    const mine = teardowns.filter((t) => t.pluginId === PLUGIN_ID)
    expect(mine.every((t) => t.cause === 'overrun' && t.decision === 'respawn')).toBe(true)
    // What the admin sees names the call, and nothing of the request.
    expect(mine[0].reason).toBe(
      `route GET:/slow ran out of time: Plugin call exceeded its ${CALL_BUDGET_MS / 1000}s time budget.`,
    )
    expect(mine.at(-1)?.reason).toContain('It is held back for 15s.')
    expect(mine.some((t) => t.reason.startsWith('schedule "acme.overrun.stuck" ran out of time'))).toBe(true)
  }, 60_000)

  it('treats a lifecycle call that cannot finish as a crash', async () => {
    const source = `
      ;(function () {
        const __plugin_exports = (globalThis.__plugin_exports = {});
        __plugin_exports.activate = async function activate() {
          await new Promise(function (r) { setTimeout(r, 60000); });
        };
      })();
    `
    await writeFile(join(dir, 'broken.js'), source)
    const loaded = await loadPluginInWorker({
      manifest: { ...manifest, id: BROKEN_ID } as PluginManifest,
      entryFileUrl: join(dir, 'broken.js'),
      assetRootPath: dir,
      settings: {},
      callBudgetMs: 300,
    })
    expect(loaded.ok).toBe(true)
    // Not `expect(...).rejects`: bun waits for that promise without
    // delivering worker messages, so the worker's answer would never arrive.
    const failure = await runLifecycleInWorker(BROKEN_ID, 'activate').catch((err: unknown) => err)
    expect((failure as Error).message).toBe('Plugin call exceeded its 0.3s time budget')

    const giveUpAt = Date.now() + 10_000
    while (!teardowns.some((t) => t.pluginId === BROKEN_ID)) {
      if (Date.now() > giveUpAt) throw new Error('no teardown reported')
      await new Promise((res) => setTimeout(res, 20))
    }
    expect(teardowns.find((t) => t.pluginId === BROKEN_ID)).toEqual({
      pluginId: BROKEN_ID,
      reason: 'lifecycle "activate" did not finish: Plugin call exceeded its 0.3s time budget',
      cause: 'crash',
      decision: 'respawn',
    })
  }, 60_000)
})
