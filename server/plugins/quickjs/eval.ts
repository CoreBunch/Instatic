/**
 * Eval/call helpers — drive a VM execution to a fully-resolved value.
 *
 * Two entry styles share one settle pipeline:
 *   - `evalString` / `evalJson` compile + run a small SOURCE STRING. Used
 *     only for one-time setup expressions (hook detection, pack init) where
 *     the code is tiny and fixed-size.
 *   - `callString` / `callVoid` invoke a persistent VM FUNCTION HANDLE with
 *     string arguments (`ctx.newString` — a direct memcpy into the VM, no
 *     compile, no escaping stringify). This is the hot path for every
 *     host→VM dispatch (`__runRoute`, `__runHookFilter`, …): the payload
 *     crosses as a plain string argument instead of being embedded in
 *     payload-sized JS source that QuickJS would have to tokenize/compile.
 *
 * Settle pattern (no asyncify):
 *   1. evalCode / callFunction runs the synchronous portion
 *   2. If the result is a Promise (e.g. from an `async function` call),
 *      we poll its state via getPromiseState
 *   3. Between polls: executePendingJobs() advances VM microtasks
 *   4. If no jobs ran and the Promise is still pending, yield to the host
 *      event loop so __hostCall's host-side .then can fire deferred.resolve
 *   5. Once fulfilled/rejected, return the value or throw the error
 *
 * Deadline guard: every entry into VM execution (async eval/call, sync
 * eval/call, timer-callback pump) registers a wall-clock deadline in a
 * per-runtime registry; ONE persistent interrupt handler aborts the runtime
 * when the clock passes the latest active deadline. A plugin stuck in a
 * tight loop is therefore always aborted, no matter which code path it
 * spins on.
 */

import type { QuickJSContext, QuickJSHandle, QuickJSRuntime } from 'quickjs-emscripten'

/**
 * Error thrown when plugin code inside the VM throws (or is aborted by the
 * wall-clock interrupt). `message` is the plugin's own error message and is
 * safe to surface in API replies / HTTP error envelopes. `vmStack` carries
 * the QuickJS-side stack frames — plugin sources are evaluated with the
 * filename `plugin:<pluginId>`, so the frames point into the plugin bundle.
 * `stack` is rewritten to show those VM frames so host-side
 * `console.error('[plugin:<id>]', err)` logging prints them. Callers must
 * never put `.stack` / `.vmStack` into HTTP response bodies.
 */
export class PluginVmError extends Error {
  readonly vmStack?: string

  constructor(message: string, vmStack?: string) {
    super(message)
    this.name = 'PluginVmError'
    if (vmStack !== undefined && vmStack.length > 0) {
      this.vmStack = vmStack
      this.stack = `${this.name}: ${message}\n${vmStack}`
    }
  }
}

/**
 * Extract the QuickJS-side stack frames from a VM eval error, if present.
 * Handles both error shapes the eval paths produce:
 *   - `PluginVmError` (rejected VM promises) carries `vmStack` directly;
 *   - `QuickJSUnwrapError` (synchronous throws surfaced by
 *     `ctx.unwrapResult`) carries the dumped VM error object as `cause`,
 *     whose `stack` is pure VM frames.
 */
export function vmStackOf(err: unknown): string | undefined {
  if (err instanceof PluginVmError) return err.vmStack
  if (err instanceof Error && err.cause && typeof err.cause === 'object') {
    const stack = (err.cause as { stack?: unknown }).stack
    if (typeof stack === 'string' && stack.length > 0) return stack
  }
  return undefined
}

interface DeadlineToken {
  expiresAt: number
}

/**
 * Active wall-clock deadlines, per runtime. Multiple evals can be in flight
 * on one context at the same time (the polling pump interleaves them), but
 * the runtime has only ONE interrupt-handler slot — a naive install-on-start
 * / remove-on-finish pair would let the first eval to finish strip the
 * deadline from every eval still running. Instead each guarded execution
 * registers a token here, and one persistent handler (installed when the
 * first token arrives, removed when the last one releases) interrupts when
 * the wall clock passes the MAX of the active deadlines. Max is the safe
 * aggregation: it never falsely interrupts an eval that still has budget,
 * while still guaranteeing the runtime cannot spin forever.
 */
const deadlinesByRuntime = new Map<QuickJSRuntime, Set<DeadlineToken>>()

function acquireDeadline(ctx: QuickJSContext, timeoutMs: number): () => void {
  const runtime = ctx.runtime
  let tokens = deadlinesByRuntime.get(runtime)
  if (!tokens) {
    const created = new Set<DeadlineToken>()
    tokens = created
    deadlinesByRuntime.set(runtime, created)
    runtime.setInterruptHandler(() => {
      if (created.size === 0) return false
      let latest = 0
      for (const token of created) {
        if (token.expiresAt > latest) latest = token.expiresAt
      }
      return Date.now() > latest
    })
  }
  const activeTokens = tokens
  const token: DeadlineToken = { expiresAt: Date.now() + timeoutMs }
  activeTokens.add(token)
  let released = false
  return () => {
    if (released) return
    released = true
    activeTokens.delete(token)
    if (activeTokens.size === 0) {
      deadlinesByRuntime.delete(runtime)
      try { runtime.removeInterruptHandler() } catch { /* runtime may already be disposed */ }
    }
  }
}

function withDeadline<T>(ctx: QuickJSContext, timeoutMs: number, body: () => Promise<T>): Promise<T> {
  const releaseDeadline = acquireDeadline(ctx, timeoutMs)
  return body().finally(releaseDeadline)
}

/**
 * Synchronous sibling of `withDeadline` — guards a fully-synchronous VM
 * execution (one-shot eval or a pending-jobs pump) with the same interrupt
 * deadline. Used by the module-pack VM (canvas render() never calls into
 * the host), by `createPluginVm`'s bootstrap + plugin-source evals, and by
 * the timer-callback pumps in `vm.ts`.
 */
export function withSyncDeadline<T>(ctx: QuickJSContext, timeoutMs: number, body: () => T): T {
  const releaseDeadline = acquireDeadline(ctx, timeoutMs)
  try {
    return body()
  } finally {
    releaseDeadline()
  }
}

/**
 * Synchronous string eval — module-pack code is fully synchronous (no host
 * calls, no Promises), so a one-shot evalCode + getString under a deadline is
 * enough. Throws via `unwrapResult` if the eval errors; a runaway eval is
 * aborted by the interrupt deadline. Reserved for one-time setup expressions
 * (pack init) — per-render dispatch goes through `callStringSync`.
 */
export function evalStringSync(
  ctx: QuickJSContext,
  code: string,
  timeoutMs: number,
  sourceName = 'instatic-eval.js',
): string {
  return withSyncDeadline(ctx, timeoutMs, () => {
    const handle = ctx.unwrapResult(ctx.evalCode(code, sourceName))
    try {
      return ctx.getString(handle)
    } finally {
      handle.dispose()
    }
  })
}

/**
 * Synchronous sibling of `callString` — invokes a persistent VM function
 * handle with string arguments and reads the string it returns. Module-pack
 * `render()` / `preview()` are contractually synchronous (no host calls,
 * no Promises), so no settle loop is needed. The arguments cross via
 * `ctx.newString` — no source compile, no escaping stringify.
 */
export function callStringSync(
  ctx: QuickJSContext,
  fnHandle: QuickJSHandle,
  args: readonly string[],
  timeoutMs: number,
): string {
  return withSyncDeadline(ctx, timeoutMs, () => {
    const argHandles = args.map((arg) => ctx.newString(arg))
    let callResult: ReturnType<QuickJSContext['callFunction']>
    try {
      callResult = ctx.callFunction(fnHandle, ctx.undefined, argHandles)
    } finally {
      for (const handle of argHandles) handle.dispose()
    }
    const resultHandle = ctx.unwrapResult(callResult)
    try {
      return ctx.getString(resultHandle)
    } finally {
      resultHandle.dispose()
    }
  })
}

function evalResolved<T>(
  ctx: QuickJSContext,
  code: string,
  read: (handle: QuickJSHandle) => T,
  timeoutMs: number,
): Promise<T> {
  // Run inside a wall-clock deadline — runaway plugin code is aborted
  // with a QuickJS `InternalError: interrupted` rather than blocking
  // the worker forever.
  return withDeadline(ctx, timeoutMs, async () => {
    const evalHandle = ctx.unwrapResult(ctx.evalCode(code, 'instatic-eval.js'))
    return settleResolved(ctx, evalHandle, read)
  })
}

/**
 * Invoke a persistent VM function handle with string arguments and drive
 * the result (sync value or Promise) to settlement. The hot-path sibling of
 * `evalResolved`: arguments enter the VM via `ctx.newString` (a memcpy), so
 * the payload is never compiled as JS source and never double-stringified.
 * Same wall-clock deadline semantics — schedules pass a higher per-call
 * budget derived from their declared `maxDurationMs`.
 */
function callResolved<T>(
  ctx: QuickJSContext,
  fnHandle: QuickJSHandle,
  args: readonly string[],
  read: (handle: QuickJSHandle) => T,
  timeoutMs: number,
): Promise<T> {
  return withDeadline(ctx, timeoutMs, async () => {
    const argHandles = args.map((arg) => ctx.newString(arg))
    let callResult: ReturnType<QuickJSContext['callFunction']>
    try {
      callResult = ctx.callFunction(fnHandle, ctx.undefined, argHandles)
    } finally {
      for (const handle of argHandles) handle.dispose()
    }
    return settleResolved(ctx, ctx.unwrapResult(callResult), read)
  })
}

/**
 * Drive an owned result handle (from `evalCode` or `callFunction`) to a
 * settled value: non-promises are read directly; promises are pumped via
 * the jobs-queue/host-event-loop poll until they fulfill or reject.
 * Consumes `evalHandle`.
 */
async function settleResolved<T>(
  ctx: QuickJSContext,
  evalHandle: QuickJSHandle,
  read: (handle: QuickJSHandle) => T,
): Promise<T> {
  // Drain any microtasks scheduled by the execution's synchronous portion.
  drainJobs(ctx)

  // Probe Promise state. For non-promises, `getPromiseState` returns a
  // fulfilled state with `notAPromise: true` and `value` set to the
  // original handle (no new ownership transfer).
  const initialState = ctx.getPromiseState(evalHandle)
  if (initialState.type === 'fulfilled' && initialState.notAPromise) {
    try {
      return read(evalHandle)
    } finally {
      evalHandle.dispose()
    }
  }

  // It IS a Promise — pump VM jobs + host event loop until it settles.
  // Reuse `initialState` on the first pass: for a settled promise each
  // `getPromiseState` call allocates a NEW owned result handle, so probing
  // twice would leak the first one (QuickJS asserts on leaked GC objects at
  // runtime-free time).
  const MAX_BATCHES = 10_000
  for (let i = 0; i < MAX_BATCHES; i += 1) {
    const state = i === 0 ? initialState : ctx.getPromiseState(evalHandle)
    if (state.type === 'fulfilled') {
      const valueHandle = state.value
      evalHandle.dispose()
      try {
        return read(valueHandle)
      } finally {
        valueHandle.dispose()
      }
    }
    if (state.type === 'rejected') {
      // `state.error` is an OWNED heap handle (see getPromiseState) — leaving
      // it alive trips QuickJS's `list_empty(&rt->gc_obj_list)` assertion
      // when the runtime is freed. `consume` dumps + disposes in one step.
      const errorValue = state.error.consume((handle) => ctx.dump(handle)) as
        | { message?: string; stack?: string }
        | string
        | undefined
      evalHandle.dispose()
      // Surface the plugin's own error message verbatim — the host's
      // logging (`[plugin:<id>]`) provides the context, so a "Plugin VM
      // threw: " prefix would just be redundant noise. The VM-side stack
      // rides along on the PluginVmError for host logs.
      if (typeof errorValue === 'object' && errorValue && errorValue.message) {
        throw new PluginVmError(
          errorValue.message,
          typeof errorValue.stack === 'string' ? errorValue.stack : undefined,
        )
      }
      throw new PluginVmError(
        typeof errorValue === 'string' ? errorValue : 'VM promise rejected with unknown error',
      )
    }
    // Still pending. Drain VM microtasks, then yield to host event loop
    // so any pending __hostCall host-side resolution can fire.
    const ranJobs = drainJobs(ctx)
    if (ranJobs === 0) {
      await new Promise<void>((res) => setTimeout(res, 0))
    }
  }
  evalHandle.dispose()
  throw new Error(`VM promise did not settle within ${MAX_BATCHES} batches`)
}

/**
 * Drain QuickJS's pending-job queue. The result is a `DisposableResult` —
 * either success (`.value` is the count of jobs that ran) or failure
 * (`.value` is the error handle). We treat any error as 0 jobs ran and
 * just dispose the error; uncaught microtask errors inside the VM usually
 * mean a plugin bug that the calling eval's reject path will surface
 * cleanly.
 */
function drainJobs(ctx: QuickJSContext): number {
  const result = ctx.runtime.executePendingJobs()
  if ('error' in result && result.error) {
    try { result.error.dispose() } catch { /* ignore */ }
    return 0
  }
  if ('value' in result && typeof result.value === 'number') {
    return result.value
  }
  return 0
}

export function callVoid(
  ctx: QuickJSContext,
  fnHandle: QuickJSHandle,
  args: readonly string[],
  timeoutMs: number,
): Promise<void> {
  return callResolved(ctx, fnHandle, args, () => undefined, timeoutMs)
}

export function callString(
  ctx: QuickJSContext,
  fnHandle: QuickJSHandle,
  args: readonly string[],
  timeoutMs: number,
): Promise<string> {
  return callResolved(ctx, fnHandle, args, (h) => ctx.getString(h), timeoutMs)
}

export async function evalJson<T>(ctx: QuickJSContext, code: string, timeoutMs: number): Promise<T> {
  const raw = await evalResolved(ctx, `JSON.stringify((${code}))`, (h) => ctx.getString(h), timeoutMs)
  return JSON.parse(raw) as T
}
