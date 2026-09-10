/**
 * Master encryption key bootstrap for reversible server secrets.
 *
 * The master key is a 32-byte (256-bit) AES key used by `encryption.ts` to
 * encrypt secrets that must be recovered later, such as AI provider API keys
 * and MFA TOTP seeds. It is loaded once at boot and cached for the lifetime of
 * the process.
 *
 * Source priority outside production:
 *
 *   1. `INSTATIC_SECRET_KEY` environment variable (base64 or hex).
 *   2. `INSTATIC_SECRET_KEY_FILE`, when set to an absolute key-file path.
 *   3. The platform-native per-user key file, but only when
 *      `INSTATIC_ALLOW_DEV_KEY_AUTOGEN=1`. It is created on first boot and
 *      re-used on later boots.
 *
 * Production deployments MUST set `INSTATIC_SECRET_KEY`; key files and dev
 * auto-generation do not replace that requirement.
 *
 * Key rotation: replace the configured key and restart. Existing encrypted
 * rows whose key fingerprint no longer matches will require re-entry or
 * re-enrollment.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import { defaultMasterKeyPath, ensureDir } from './paths'

const REQUIRED_KEY_BYTES = 32
const ENV_VAR_NAME = 'INSTATIC_SECRET_KEY'
const FILE_ENV_VAR_NAME = 'INSTATIC_SECRET_KEY_FILE'
const DEV_AUTOGEN_ENV_VAR_NAME = 'INSTATIC_ALLOW_DEV_KEY_AUTOGEN'

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
  const rawBytes = await readMasterKeyBytes()
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

async function readMasterKeyBytes(): Promise<Uint8Array> {
  const envValue = process.env[ENV_VAR_NAME]
  if (envValue?.trim()) {
    return parseAndValidateKey(envValue.trim(), `env var ${ENV_VAR_NAME}`)
  }

  if (process.env.NODE_ENV === 'production') {
    throw new MasterKeyConfigurationError(
      `[secrets/masterKey] ${ENV_VAR_NAME} is required in production. ` +
        'Generate one with: bun run scripts/generate-secret-key.ts',
    )
  }

  const filePath = process.env[FILE_ENV_VAR_NAME]?.trim()
  if (filePath) {
    if (!isAbsolute(filePath)) {
      throw new MasterKeyConfigurationError(
        `[secrets/masterKey] ${FILE_ENV_VAR_NAME} must be an absolute path.`,
      )
    }
    return readKeyFile(filePath)
  }

  if (process.env[DEV_AUTOGEN_ENV_VAR_NAME] !== '1') {
    throw new MasterKeyConfigurationError(
      `[secrets/masterKey] Set ${ENV_VAR_NAME}, ${FILE_ENV_VAR_NAME}, or ` +
        `${DEV_AUTOGEN_ENV_VAR_NAME}=1 for local development.`,
    )
  }

  return readOrCreateDevKey(defaultMasterKeyPath())
}

async function readKeyFile(path: string): Promise<Uint8Array> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (err) {
    throw new MasterKeyConfigurationError(
      `[secrets/masterKey] Unable to read master key file ${path}.`,
      { cause: err },
    )
  }
  return parseAndValidateKey(raw.trim(), `file ${path}`)
}

async function readOrCreateDevKey(path: string): Promise<Uint8Array> {
  try {
    const raw = await readFile(path, 'utf8')
    return parseAndValidateKey(raw.trim(), `file ${path}`)
  } catch (err) {
    if (!isErrorCode(err, 'ENOENT')) {
      if (err instanceof MasterKeyConfigurationError) throw err
      throw new MasterKeyConfigurationError(
        `[secrets/masterKey] Unable to read master key file ${path}.`,
        { cause: err },
      )
    }
  }

  const fresh = crypto.getRandomValues(new Uint8Array(REQUIRED_KEY_BYTES))
  await ensureDir(dirname(path))

  try {
    await writeFile(path, bytesToBase64(fresh) + '\n', {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    })
  } catch (err) {
    // Another dev process may have created the key after the initial read.
    if (isErrorCode(err, 'EEXIST')) return readKeyFile(path)
    throw err
  }

  console.log(`[master-key] generated dev key at ${path}`)
  return fresh
}

function parseAndValidateKey(value: string, source: string): Uint8Array {
  let bytes: Uint8Array
  try {
    bytes = /^[0-9a-fA-F]{64}$/.test(value) ? hexToBytes(value) : base64ToBytes(value)
  } catch (err) {
    throw new MasterKeyConfigurationError(
      `[secrets/masterKey] ${source} is not valid base64 or hex. ` +
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
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  return hex.slice(0, 16)
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

function hexToBytes(value: string): Uint8Array {
  const out = new Uint8Array(value.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
  return btoa(binary)
}
