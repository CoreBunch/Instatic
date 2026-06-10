/**
 * TypeBox schemas for `network.fetch` / `network.abort` api-call arguments.
 */

import { Type } from '@sinclair/typebox'

/**
 * Shared host-pattern regex — same shape as `manifest.ts`. Re-declared here
 * (instead of imported) so this file stays a single source of truth for the
 * worker IPC schemas and doesn't pull in manifest validation.
 */
export const NETWORK_HOST_PATTERN = /^(?:\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/

export const NetworkFetchInitSchema = Type.Object(
  {
    method: Type.Optional(Type.String({ maxLength: 16 })),
    headers: Type.Optional(Type.Record(Type.String(), Type.String())),
    body: Type.Optional(Type.String()),
    // How `body` is encoded on the wire: 'utf8' (the string IS the text,
    // default) or 'base64' (the string encodes raw bytes — the VM's fetch
    // shim sends ArrayBuffer / TypedArray request bodies this way). See
    // `protocol/bodyEncoding.ts`.
    bodyEncoding: Type.Optional(Type.Union([Type.Literal('utf8'), Type.Literal('base64')])),
    // Plugin-minted correlation id for AbortSignal cancellation. The
    // bootstrap's fetch polyfill assigns this when the call has a signal;
    // if the signal fires, the polyfill posts `network.abort` with the
    // same id so the host can drop the in-flight request. Plain JS
    // identifier shape — the bootstrap generates `'a' + counter + '_' + ts36`.
    abortId: Type.Optional(Type.String({ minLength: 1, maxLength: 128, pattern: '^[a-zA-Z0-9_]+$' })),
  },
  { additionalProperties: false },
)

export const NetworkAbortArgSchema = Type.Object(
  {
    abortId: Type.String({ minLength: 1, maxLength: 128, pattern: '^[a-zA-Z0-9_]+$' }),
  },
  { additionalProperties: false },
)
