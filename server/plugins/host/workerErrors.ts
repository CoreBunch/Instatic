/**
 * Translate worker error payloads (`{ error, stack }` on `*-result`
 * messages) into host-side errors and log lines.
 *
 * The `stack` field carries QuickJS-side frames — plugin sources are
 * evaluated with the filename `plugin:<id>`, so the frames point into the
 * plugin bundle. Stacks are for `[plugin:<id>]` server logs ONLY: API
 * replies and HTTP error envelopes carry just the message.
 */

/**
 * Build the host-side `Error` for a failed worker call. The message is what
 * callers surface (API replies, lifecycle status rows); when the worker
 * forwarded a VM stack, `.stack` is rewritten to show those frames so any
 * `console.error('[plugin:<id>]', err)` along the way prints them.
 */
export function workerCallError(message: string, stack?: string): Error {
  const err = new Error(message)
  if (stack) err.stack = `Error: ${message}\n${stack}`
  return err
}

/**
 * Format a worker failure for a `[plugin:<id>]` console line — the message,
 * plus the VM stack frames on following lines when the worker sent them.
 */
export function describeWorkerError(error: string | undefined, stack: string | undefined, fallback: string): string {
  const message = error ?? fallback
  return stack ? `${message}\n${stack}` : message
}
