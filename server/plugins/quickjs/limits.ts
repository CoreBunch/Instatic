/**
 * Resource limits for plugin QuickJS VMs — defense against runaway or
 * malicious plugins.
 *
 * Plugin VMs get:
 *   • A hard memory ceiling enforced by the QuickJS runtime
 *     (`setMemoryLimit`). Allocations beyond the limit throw an
 *     `OutOfMemory` error inside the VM.
 *   • A bounded stack size (`setMaxStackSize`) so a recursive plugin can't
 *     exhaust the host's WASM stack.
 *   • A wall-clock interrupt per VM execution (the per-runtime deadline
 *     registry in `eval.ts`). The VM cooperatively checks the interrupt
 *     flag during execution; a plugin stuck in an infinite loop — at module
 *     top level, in any `__run*` call, or in a timer callback — is aborted
 *     within the deadline.
 *
 * Defaults are picked to be invisible for normal plugin work and harsh
 * for runaways. Plugins that legitimately need higher caps will surface
 * memory errors and we can add a per-plugin override field later.
 */

/** 64 MB max heap per plugin VM. */
export const DEFAULT_MEMORY_LIMIT_BYTES = 64 * 1024 * 1024

/** 1 MB max stack — plenty for normal use, fatal for runaway recursion. */
export const DEFAULT_STACK_SIZE_BYTES = 1 * 1024 * 1024

/**
 * 5 second deadline on VM execution per eval call. Lifecycle hooks, route
 * handlers, hook listeners, and loop fetches all use this same budget. It
 * bounds time spent RUNNING plugin code: the interrupt only fires while
 * bytecode executes, so time spent awaiting a host call (storage, `fetch`)
 * does not count against it. `PLUGIN_CALL_BUDGET_MS` bounds that.
 */
export const DEFAULT_EVAL_TIMEOUT_MS = 5_000

/**
 * 20 second wall-clock budget for one whole plugin call (lifecycle hook,
 * route, hook listener/filter, loop fetch, media call), awaits included.
 * Schedule fires use their `maxDurationMs` instead.
 *
 * It sits well below the host's 30 s worker RPC timeout
 * (`DEFAULT_RPC_TIMEOUT_MS`) on purpose: that timeout tears the worker down
 * and rejects every sibling call in flight, so a slow handler must fail on
 * its own, here, long before it. 20 s still fits a handler that chains a few
 * slow upstream requests (the default outbound request timeout is 15 s).
 */
export const PLUGIN_CALL_BUDGET_MS = 20_000

/**
 * How long one plugin `fetch` may take when the plugin sets no `timeout`:
 * DNS, every redirect hop and the whole response body included. Below the
 * call budget, so a handler waiting on one stalled upstream gets the
 * rejection in time to answer.
 */
export const DEFAULT_PLUGIN_FETCH_TIMEOUT_MS = 15_000

/**
 * Time a call keeps for itself after its last outbound request: a request
 * may run until this long before the call's budget ends, never to the end.
 * Without it a request cut off by the budget would reject at the instant the
 * call fails, and the handler's own error handling would never run. A tenth
 * of the budget, at least one second, at most half the budget.
 */
export function fetchHandlingMarginMs(budgetMs: number): number {
  return Math.min(Math.max(1_000, budgetMs / 10), budgetMs / 2)
}

/**
 * A request that could run for less than this is not started: it rejects at
 * once with the same catchable timeout error.
 */
export const MIN_PLUGIN_FETCH_WINDOW_MS = 250

/**
 * 2 second wall-clock deadline per module-pack eval call. Shorter than the
 * full-plugin budget because canvas `render()` / `preview()` functions are
 * simple synchronous transforms with no host I/O — 2 s is still generous.
 * Passed as the per-call deadline argument to the shared interrupt guard;
 * the memory and stack ceilings above are identical for both VMs.
 */
export const MODULE_PACK_EVAL_TIMEOUT_MS = 2_000
