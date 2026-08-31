/**
 * Master encryption key bootstrap for reversible server secrets.
 *
 * The master key is a 32-byte (256-bit) AES key used by `encryption.ts` to
 * encrypt secrets that must be recovered later, such as AI provider API keys
 * and MFA TOTP seeds. It is loaded once at boot and cached for the lifetime of
 * the process.
 *
 * Source priority:
 *
 *   1. `INSTATIC_SECRET_KEY` environment variable (base64).
 *      Production deployments MUST set this. If unset in production
 *      (`NODE_ENV=production`), boot fails loudly with instructions.
 *
 *   2. `.tmp/secret.key` file in the working directory.
 *      Dev / non-production fallback. Auto-created on first boot so a fresh
 *      `bun run dev` works without manual setup. The file is intentionally
 *      under `.tmp/` (already git-ignored).
 *
 * Key rotation: replace the env var or `.tmp/secret.key` file and restart.
 * Existing encrypted rows whose key fingerprint no longer matches will require
 * re-entry or re-enrollment.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const REQUIRED_KEY_BYTES = 32
const DEV_KEY_PATH = '.tmp/secret.key'
const ENV_VAR_NAME = 'INSTATIC_SECRET_KEY'

let cachedKey: CryptoKey | null = null
let cachedFingerprint: string | null = null

export class MasterKeyConfigurationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'MasterKeyConfigurationError'
  }
}

export async function loadMasterKey(): Promise<CryptoKey> {
  if (cachedKey) return cachedKey
  const rawBytes = readMasterKeyBytes()
  cachedKey = await crypto.subtle.importKey(
    'raw',
    rawBytes as BufferSource,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  )
  cachedFingerprint = await computeMasterKeyFingerprint(rawBytes)
  return cachedKey
}

export async function getMasterKeyFingerprint(): Promise<string> {
  if (!cachedFingerprint) {
    await loadMasterKey()
  }
  if (!cachedFingerprint) {
    throw new Error('[secrets/masterKey] Fingerprint unavailable after loadMasterKey().')
  }
  return cachedFingerprint
}

export function __resetMasterKeyCacheForTesting(): void {
  cachedKey = null
  cachedFingerprint = null
}

function readMasterKeyBytes(): Uint8Array {
  const envValue = process.env[ENV_VAR_NAME]
  if (envValue && envValue.trim()) {
    return parseAndValidateBase64(envValue.trim(), `env var ${ENV_VAR_NAME}`)
  }

  if (process.env.NODE_ENV === 'production') {
    throw new MasterKeyConfigurationError(
      `[secrets/masterKey] ${ENV_VAR_NAME} is required in production. ` +
      'Generate one with: bun run scripts/generate-secret-key.ts',
    )
  }

  return readOrCreateDevKey(DEV_KEY_PATH)
}

function readOrCreateDevKey(path: string): Uint8Array {
  if (existsSync(path)) {
    const raw = readFileSync(path, 'utf8').trim()
    return parseAndValidateBase64(raw, `file ${path}`)
  }
  const fresh = crypto.getRandomValues(new Uint8Array(REQUIRED_KEY_BYTES))
  const dir = dirname(path)
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true })
  const base64 = bytesToBase64(fresh)
  writeFileSync(path, base64 + '\n', 'utf8')
  try {
    chmodSync(path, 0o600)
  } catch {
    // chmod is best-effort on non-POSIX filesystems.
  }
  console.warn(
    `[secrets/masterKey] Generated a new dev master key at ${path}. ` +
    `Set ${ENV_VAR_NAME} for production.`,
  )
  return fresh
}

function parseAndValidateBase64(value: string, source: string): Uint8Array {
  let bytes: Uint8Array
  try {
    bytes = base64ToBytes(value)
  } catch (err) {
    throw new MasterKeyConfigurationError(
      `[secrets/masterKey] ${source} is not valid base64. ` +
      'Generate a new key with: bun run scripts/generate-secret-key.ts',
      { cause: err },
    )
  }
  if (bytes.length !== REQUIRED_KEY_BYTES) {
    throw new MasterKeyConfigurationError(
      `[secrets/masterKey] ${source} decoded to ${bytes.length} bytes; ` +
      `must be exactly ${REQUIRED_KEY_BYTES}. ` +
      'Generate a new key with: bun run scripts/generate-secret-key.ts',
    )
  }
  return bytes
}

async function computeMasterKeyFingerprint(keyBytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', keyBytes as BufferSource)
  return Buffer.from(digest).toString('hex').slice(0, 16)
}

function base64ToBytes(value: string): Uint8Array {
  // `atob` is the decoder here on purpose: it THROWS on malformed base64,
  // which is what `parseAndValidateBase64` reports as a configuration error.
  // `Buffer.from(value, 'base64')` would silently discard invalid characters
  // and hand back a plausible-looking wrong key.
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0))
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}
