/**
 * The wall-clock call budget, through a REAL plugin worker.
 *
 * A call still pending when its budget runs out fails alone:
 *   - the overrunning route answers 504;
 *   - a sibling route in flight on the same plugin completes normally;
 *   - the worker is not restarted and keeps serving;
 *   - the abandoned handler is not cancelled: it resumes when its await
 *     returns and finishes its work (which is why a 504 means "outcome
 *     unknown" and handlers must be idempotent);
 *   - a schedule that overruns its `maxDurationMs` reports `timeout`;
 *   - a dead upstream is not an overrun: the handler catches the request
 *     timeouts and answers normally.
 *
 * The worker, VM and message protocol are the production ones. The api-call
 * dispatcher is a recorder (no database).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginManifest } from '@core/plugin-sdk'
import { dispatchApiCall } from '../../../server/plugins/host/apiDispatch'
import { replyApiError, replyApiOk } from '../../../server/plugins/host/apiReplies'
import { handleRoutesRegister } from '../../../server/plugins/host/handlers/routes'
import { hostPlugins } from '../../../server/plugins/host/registry'
import { loadPluginInWorker, runLifecycleInWorker, runRouteInWorker } from '../../../server/plugins/host/rpc'
import { requestFromWorker, resetPluginWorker, setApiCallDispatcher } from '../../../server/plugins/host/workerPool'
import { workers } from '../../../server/plugins/host/workerState'
import type { ApiCallFor } from '../../../server/plugins/protocol/apiCallSchema'

const PLUGIN_ID = 'acme.budget'
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
      await sleep(${CALL_BUDGET_MS + 600});
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

const manifest = {
  id: PLUGIN_ID,
  name: 'Budget',
  version: '1.0.0',
  grantedPermissions: ['cms.routes', 'cms.routes.public', 'cms.storage', 'cms.schedule', 'network.outbound'],
  networkAllowedHosts: ['down.example.com'],
  resources: [{ id: 'notes', title: 'Notes', fields: [] }],
} as unknown as PluginManifest

/** Every host call the plugin made, in order. */
const calls: string[] = []
let dir = ''

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

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'instatic-budget-'))
  await writeFile(join(dir, 'index.js'), SOURCE)
  setApiCallDispatcher(async (call) => {
    calls.push(call.target)
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
    replyApiOk(call.pluginId, call.correlationId, null)
  })
  const loaded = await loadPluginInWorker({
    manifest,
    entryFileUrl: join(dir, 'index.js'),
    assetRootPath: dir,
    settings: {},
    callBudgetMs: CALL_BUDGET_MS,
  })
  if (!loaded.ok) throw new Error(loaded.error ?? 'load failed')
  await runLifecycleInWorker(PLUGIN_ID, 'activate')
})

afterAll(async () => {
  await resetPluginWorker()
  hostPlugins.delete(PLUGIN_ID)
  setApiCallDispatcher(dispatchApiCall)
  await rm(dir, { recursive: true, force: true })
})

describe('plugin call budget through a real worker', () => {
  it('fails the overrunning route alone with 504; a sibling completes and the worker keeps serving', async () => {
    const worker = workers.get(PLUGIN_ID)
    const slow = get('/slow')
    // In flight when /slow overruns, and inside its own budget.
    await new Promise((res) => setTimeout(res, 600))
    const sibling = get('/sibling')

    const slowRes = await slow
    expect(slowRes.status).toBe(504)
    expect(await slowRes.json()).toEqual({ error: `Plugin call exceeded its ${CALL_BUDGET_MS / 1000}s time budget` })

    const siblingRes = await sibling
    expect(siblingRes.status).toBe(200)
    expect(await siblingRes.json()).toEqual({ done: true })

    // Same worker, still answering.
    expect(workers.get(PLUGIN_ID)).toBe(worker)
    expect((await get('/ok')).status).toBe(200)

    // The abandoned handler was not cancelled: it resumed and wrote. A 504
    // therefore means "outcome unknown", not "nothing happened".
    await new Promise((res) => setTimeout(res, 900))
    expect(calls).toContain('cms.storage.create')
  }, 60_000)

  it('a dead upstream gives the handler catchable timeouts and a normal answer, never an overrun', async () => {
    const res = await get('/dead-upstream')
    expect(res.status).toBe(200)
    // The first request timed out with room to spare; the second had too
    // little time left and was refused without going out. Both were caught.
    expect(await res.json()).toEqual({ seen: ['TimeoutError', 'TimeoutError'] })
  }, 60_000)

  it('reports a schedule that overruns its maxDurationMs as a timeout', async () => {
    // Sent on the worker transport itself: other suites in this process mock
    // the scheduler's `runScheduleInWorker` wrapper.
    const run = await requestFromWorker(
      PLUGIN_ID,
      {
        kind: 'run-schedule',
        correlationId: 'budget-schedule',
        pluginId: PLUGIN_ID,
        scheduleId: `${PLUGIN_ID}.stuck`,
        maxDurationMs: 300,
      },
      'schedule-result',
    )
    expect(run.status).toBe('timeout')
    expect(run.error).toBe('Plugin call exceeded its 0.3s time budget')
    expect((await get('/ok')).status).toBe(200)
  }, 60_000)
})
