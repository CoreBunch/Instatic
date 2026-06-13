import { decryptSecret, encryptSecret } from '../secrets/encryption'
import {
  getMasterKeyFingerprint,
  loadMasterKey,
  MasterKeyConfigurationError,
} from '../secrets/masterKey'
import { jsonResponse } from '../http'
import { verifyTotpCode } from './mfa'

export interface EncryptedTotpSecret {
  ciphertext: Uint8Array
  iv: Uint8Array
  keyFingerprint: string | null
}

class TotpSecretError extends Error {
  readonly status: number

  constructor(message: string, status = 500, options?: ErrorOptions) {
    super(message, options)
    this.name = 'TotpSecretError'
    this.status = status
  }
}

export function encryptedTotpSecretFromParts(
  ciphertext: Uint8Array | null,
  iv: Uint8Array | null,
  keyFingerprint: string | null,
): EncryptedTotpSecret | null {
  if (!ciphertext || !iv) return null
  return { ciphertext, iv, keyFingerprint }
}

export async function encryptTotpSecret(plaintext: string): Promise<EncryptedTotpSecret> {
  const masterKey = await loadMasterKey()
  const encrypted = await encryptSecret(masterKey, plaintext)
  return {
    ciphertext: encrypted.ciphertext,
    iv: encrypted.iv,
    keyFingerprint: await getMasterKeyFingerprint(),
  }
}

async function decryptTotpSecret(
  encrypted: EncryptedTotpSecret,
): Promise<string> {
  const currentFingerprint = await getMasterKeyFingerprint()
  if (encrypted.keyFingerprint && encrypted.keyFingerprint !== currentFingerprint) {
    throw new TotpSecretError(
      'Stored MFA secret was encrypted with a different server secret key. Re-enroll TOTP MFA.',
      409,
    )
  }

  try {
    const masterKey = await loadMasterKey()
    return await decryptSecret(masterKey, encrypted)
  } catch (err) {
    throw new TotpSecretError(
      'Stored MFA secret could not be decrypted. Re-enroll TOTP MFA.',
      500,
      { cause: err },
    )
  }
}

export async function verifyEncryptedTotpCode(
  encrypted: EncryptedTotpSecret | null,
  code: string,
): Promise<boolean> {
  if (!encrypted) return false
  const secret = await decryptTotpSecret(encrypted)
  try {
    return verifyTotpCode(secret, code)
  } catch {
    return false
  }
}

export function totpSecretErrorResponse(err: unknown): Response | null {
  if (err instanceof MasterKeyConfigurationError) {
    return jsonResponse(
      { error: `MFA secret encryption is not configured: ${err.message.replace('[secrets/masterKey] ', '')}` },
      { status: 500 },
    )
  }
  if (err instanceof TotpSecretError) {
    return jsonResponse({ error: err.message }, { status: err.status })
  }
  return null
}
