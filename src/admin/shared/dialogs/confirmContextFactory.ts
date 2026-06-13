/**
 * createConfirmContext — shared machinery for "preview impact, then either
 * fast-commit or show a confirmation dialog" providers.
 *
 * Both <FrameworkChangeConfirmProvider/> and <VCDeletionConfirmProvider/>
 * follow the same lifecycle:
 *   1. A caller requests a destructive change through the consumer hook.
 *   2. The provider resolves the request — computing the impact and deciding
 *      whether it can be handled immediately (no impact, or routed to another
 *      flow) or must defer to an impact dialog.
 *   3. If deferred, pending state holds `{ request, impact }`; the dialog
 *      commits on confirm and clears on cancel.
 *
 * The only per-dialog parts are the impact computation (`resolve`) and the
 * dialog body — everything else (pending state, confirm/cancel/commit
 * lifecycle, the context object, and the consumer hook's no-provider
 * fallback) is identical and lives here.
 *
 * This is a non-component leaf: each dialog calls `createConfirmContext` from
 * its own (non-component) hook module and authors a thin Provider component
 * that supplies `resolve` + the dialog body, so the Provider module keeps its
 * Fast Refresh-friendly "components-only" exports.
 */

import { createContext, use, useState, type Context as ReactContext } from 'react'

/** A request that knows how to perform its own side-effect once confirmed. */
interface CommittableRequest {
  commit: () => void
}

/**
 * Outcome of resolving a request:
 *   - `handled` — a fast path already ran (immediate commit, or handoff to
 *     another flow); no dialog is shown.
 *   - `confirm` — the change has impact; defer to the dialog with `impact`.
 */
export type ConfirmResolution<TImpact> =
  | { status: 'handled' }
  | { status: 'confirm'; impact: TImpact }

interface PendingConfirmState<TRequest, TImpact> {
  request: TRequest
  // Captured at resolve time so the dialog renders the impact computed
  // *before* any state churn. Re-computing while the dialog is open could
  // yield inconsistent results.
  impact: TImpact
}

interface ConfirmContextValue<TRequest> {
  confirm: (request: TRequest) => void
}

interface ConfirmController<TRequest, TImpact> {
  confirm: (request: TRequest) => void
  pending: PendingConfirmState<TRequest, TImpact> | null
  handleCancel: () => void
  handleConfirm: () => void
}

interface ConfirmContextFactory<TRequest extends CommittableRequest, TImpact> {
  /** The React context object — provided by the Provider, read by `useConfirm`. */
  Context: ReactContext<ConfirmContextValue<TRequest> | null>
  /**
   * Consumer hook returning `confirm(request)` from the nearest provider.
   * Degrades to immediate commit when no provider is mounted (test isolation).
   */
  useConfirm: () => (request: TRequest) => void
  /**
   * Provider-side hook owning the pending/confirm/cancel lifecycle. The
   * provider supplies `resolve` (its impact computation + fast-path handling)
   * and renders the dialog from the returned `pending` state.
   */
  useConfirmController: (
    resolve: (request: TRequest) => ConfirmResolution<TImpact>,
  ) => ConfirmController<TRequest, TImpact>
}

export function createConfirmContext<
  TRequest extends CommittableRequest,
  TImpact,
>(): ConfirmContextFactory<TRequest, TImpact> {
  const Context = createContext<ConfirmContextValue<TRequest> | null>(null)

  function useConfirm(): (request: TRequest) => void {
    const ctx = use(Context)
    if (ctx) return ctx.confirm
    // No provider mounted (the editor wraps its sidebar so this is the
    // production path; tests rendering a panel in isolation are the only
    // exception) — commit immediately, just without the dialog.
    return (request) => request.commit()
  }

  function useConfirmController(
    resolve: (request: TRequest) => ConfirmResolution<TImpact>,
  ): ConfirmController<TRequest, TImpact> {
    const [pending, setPending] = useState<PendingConfirmState<TRequest, TImpact> | null>(null)

    const confirm = (request: TRequest) => {
      const resolution = resolve(request)
      if (resolution.status === 'confirm') {
        setPending({ request, impact: resolution.impact })
      }
    }

    const handleCancel = () => {
      setPending(null)
    }

    const handleConfirm = () => {
      if (!pending) return
      pending.request.commit()
      setPending(null)
    }

    return { confirm, pending, handleCancel, handleConfirm }
  }

  return { Context, useConfirm, useConfirmController }
}
