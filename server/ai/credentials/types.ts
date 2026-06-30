/**
 * Credential record + wire shapes for the AI provider credential store.
 *
 * Two distinct types intentionally:
 *
 *   - `CredentialRecord`  — server-only. Carries the raw ciphertext + iv;
 *                            NEVER serialised over HTTP.
 *   - `CredentialView`    — wire-safe projection. Exposes id, providerId,
 *                            authMode, displayLabel, key fingerprint, and
 *                            timestamps. No plaintext, no ciphertext, no iv.
 *
 * The split is gated by `ai-credentials-never-leak.test.ts` (Phase 1).
 *
 * Auth mode + column shape:
 *   apiKey   → ciphertext set, iv set, baseUrl null
 *   baseUrl  → baseUrl set; ciphertext + iv optional (bearer-protected
 *              endpoints store an apiKey too)
 *   oauth    → ciphertext set, iv set, baseUrl null; ciphertext is a
 *              provider-specific token JSON envelope
 */

import type { AiAuthMode, AiProviderId } from '../runtime/types'
import type { OpenAiOAuthSecret } from '../oauth/openai'

export interface CredentialRecord {
  readonly id: string
  readonly userId: string
  readonly providerId: AiProviderId
  readonly authMode: AiAuthMode
  readonly displayLabel: string
  readonly ciphertext: Uint8Array | null
  readonly iv: Uint8Array | null
  readonly baseUrl: string | null
  readonly keyFingerprint: string | null
  readonly createdAt: string
  readonly updatedAt: string
  readonly lastUsedAt: string | null
}

/**
 * Wire-safe projection. This is the ONLY shape the HTTP layer ever returns.
 *
 * `keyFingerprintCurrent` is true when the row's stored fingerprint matches
 * the live master key — false means "your master key rotated; re-enter".
 * Ambient rows have no fingerprint (null) and are always reported true.
 */
export interface CredentialView {
  readonly id: string
  readonly providerId: AiProviderId
  readonly authMode: AiAuthMode
  readonly displayLabel: string
  readonly baseUrl: string | null
  readonly keyFingerprintCurrent: boolean
  readonly createdAt: string
  readonly lastUsedAt: string | null
}

// ---------------------------------------------------------------------------
// Create + update inputs — bodies the HTTP handlers parse and hand in.
// ---------------------------------------------------------------------------

export type CreateCredentialInput =
  | {
      providerId: AiProviderId
      authMode: 'apiKey'
      displayLabel: string
      apiKey: string
    }
  | {
      providerId: AiProviderId
      authMode: 'baseUrl'
      displayLabel: string
      baseUrl: string
      apiKey?: string
    }
  | {
      providerId: 'openai'
      authMode: 'oauth'
      displayLabel: string
      oauth: OpenAiOAuthSecret
    }

/**
 * Update: only mutable fields. Auth mode is intentionally immutable — to
 * switch modes the user creates a new credential (different rows = different
 * keys, easier to reason about audit).
 */
export type UpdateCredentialInput = {
  displayLabel?: string
  /** Replace the API key (apiKey or baseUrl-with-bearer modes only). */
  apiKey?: string
  /** Replace the base URL (baseUrl mode only). */
  baseUrl?: string
}
