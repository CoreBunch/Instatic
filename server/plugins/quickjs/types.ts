/**
 * Public types for the QuickJS plugin VM: the environment the host provides
 * (`PluginVmEnv`), the strongly-typed handle the host uses to drive plugin
 * code (`PluginVm`), and the route context shape (`VmRouteContext`).
 */

export interface PluginVmEnv {
  pluginId: string
  manifestVersion: string
  /** Permissions granted at install time — surfaced via api.plugin.permissions. */
  grantedPermissions: string[]
  /**
   * Asset base path for the plugin's installed files, e.g.
   * `/uploads/plugins/<id>/<version>`. Used by `api.plugin.assetUrl(path)`
   * to build URLs for static files the plugin shipped in its zip.
   */
  assetBasePath: string
  /** Initial settings snapshot — read synchronously inside the VM via api.cms.settings.get. */
  settings: Record<string, string | number | boolean>
  /**
   * Dispatch a host-side api-call. The implementation MUST validate
   * permission + target on the host side (see `dispatchApiCall` in
   * `host/apiDispatch.ts`). Return value is JSON-serializable.
   */
  hostCall: (target: string, args: unknown[]) => Promise<unknown>
  /**
   * Stream a log line back to the host. Equivalent to `api.plugin.log(...)`.
   * Kept separate from hostCall so the existing `log` worker→main event
   * stays a fire-and-forget message (no correlation id).
   */
  log: (args: unknown[]) => void
}

export interface PluginVm {
  readonly pluginId: string
  /** Names of lifecycle hooks the plugin actually exported. */
  readonly exportedHooks: ReadonlyArray<'install' | 'activate' | 'deactivate' | 'uninstall' | 'migrate'>
  runLifecycle: (hook: 'install' | 'activate' | 'deactivate' | 'uninstall') => Promise<void>
  runMigrate: (fromVersion: string) => Promise<void>
  runRoute: (routeKey: string, ctx: VmRouteContext) => Promise<unknown>
  runHookListener: (listenerId: string, payload: unknown) => Promise<void>
  runHookFilter: (filterId: string, value: unknown, context?: Record<string, unknown>) => Promise<unknown>
  runLoopFetch: (sourceId: string, ctx: unknown) => Promise<{ items: unknown[]; totalItems: number }>
  runLoopPreview: (sourceId: string, ctx: unknown) => Promise<unknown[]>
  /**
   * Fire a scheduled job's handler. `maxDurationMs` overrides the VM's
   * default 5s deadline for this call only — schedules can declare a
   * larger budget at registration time (host-capped at 5 minutes).
   */
  runSchedule: (scheduleId: string, maxDurationMs: number) => Promise<void>
  /** Update the VM's settings mirror so subsequent api.cms.settings.get() sees the new values. */
  updateSettings: (next: Record<string, string | number | boolean>) => Promise<void>
  /**
   * Invoke a method on a plugin-registered media storage adapter. The host
   * uses this when the upload pipeline needs the adapter to sign an upload
   * plan or commit / cleanup. Bytes are NEVER carried through this call —
   * the adapter only signs URLs; the host streams payloads outside the VM.
   *
   * `method` is one of `beginWrite`, `finalizeWrite`, `abortWrite`,
   * `delete`, `getReadUrl`, `verify` (see `MediaStorageAdapter` in
   * `src/core/plugin-sdk/types.ts`).
   */
  runMediaAdapterCall: (adapterId: string, method: string, args: unknown[]) => Promise<unknown>
  /**
   * Apply a registered URL transformer. Receives `{ path, ctx }`, returns
   * either the rewritten path (string) or `null` for "no change".
   */
  runMediaUrlTransformer: (transformerId: string, payload: { path: string; ctx: unknown }) => Promise<string | null>
  dispose: () => void
}

interface VmRouteContext {
  request: {
    url: string
    method: string
    headers: Record<string, string>
    /** Raw body — text verbatim for `bodyEncoding: 'utf8'`, base64 bytes otherwise. */
    body: string
    bodyEncoding: 'utf8' | 'base64'
  }
  /**
   * Pre-parsed body fields. Multipart file fields arrive as
   * `SerializedUploadedFile` markers (see `protocol/messages.ts`); the
   * bootstrap materializes them into file facades before the handler runs.
   */
  body: Record<string, unknown>
  user: { id: string; email: string; capabilities: string[] } | null
}
