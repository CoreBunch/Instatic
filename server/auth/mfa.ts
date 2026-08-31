import { createHash, createHmac, randomBytes } from 'node:crypto'
import { constantTimeEqual } from './tokens'

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const TOTP_STEP_MS = 30_000
const TOTP_DIGITS = 6
const TOTP_WINDOW = 1

export function generateTotpSecret(bytes = 20): string {
  return encodeBase32(randomBytes(bytes))
}

export function totpProvisioningUri(input: {
  issuer: string
  accountName: string
  secret: string
}): string {
  const label = `${input.issuer}:${input.accountName}`
  const params = new URLSearchParams({
    secret: input.secret,
    issuer: input.issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_MS / 1000),
  })
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`
}

export function verifyTotpCode(secret: string, code: string, now = Date.now()): boolean {
  const normalized = normalizeMfaCode(code)
  if (!/^\d{6}$/.test(normalized)) return false
  const counter = Math.floor(now / TOTP_STEP_MS)
  for (let offset = -TOTP_WINDOW; offset <= TOTP_WINDOW; offset += 1) {
    if (constantTimeEqual(normalized, totpAtCounter(secret, counter + offset))) return true
  }
  return false
}

export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const raw = randomBytes(8).toString('hex')
    return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`
  })
}

export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(normalizeMfaCode(code)).digest('hex')
}

export function findMatchingRecoveryCodeHash(
  code: string,
  hashes: readonly string[],
): string | null {
  const candidate = hashRecoveryCode(code)
  for (const hash of hashes) {
    if (constantTimeEqual(candidate, hash)) return hash
  }
  return null
}

function encodeBase32(bytes: Buffer): string {
  let bits = ''
  for (const byte of bytes) bits += byte.toString(2).padStart(8, '0')
  let out = ''
  for (let i = 0; i < bits.length; i += 5) {
    const chunk = bits.slice(i, i + 5).padEnd(5, '0')
    out += BASE32_ALPHABET[Number.parseInt(chunk, 2)]!
  }
  return out
}

function decodeBase32(secret: string): Buffer {
  let bits = ''
  for (const char of secret.replace(/=+$/g, '').toUpperCase()) {
    const value = BASE32_ALPHABET.indexOf(char)
    if (value < 0) throw new Error('Invalid TOTP secret')
    bits += value.toString(2).padStart(5, '0')
  }
  const bytes: number[] = []
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(Number.parseInt(bits.slice(i, i + 8), 2))
  }
  return Buffer.from(bytes)
}

function normalizeMfaCode(code: string): string {
  return code.trim().replace(/[\s-]/g, '').toLowerCase()
}

function totpAtCounter(secret: string, counter: number): string {
  const key = decodeBase32(secret)
  const counterBytes = Buffer.alloc(8)
  counterBytes.writeBigUInt64BE(BigInt(counter))
  const digest = createHmac('sha1', key).update(counterBytes).digest()
  const offset = digest[digest.length - 1]! & 0x0f
  const value = (
    ((digest[offset]! & 0x7f) << 24)
    | ((digest[offset + 1]! & 0xff) << 16)
    | ((digest[offset + 2]! & 0xff) << 8)
    | (digest[offset + 3]! & 0xff)
  ) % 1_000_000
  return value.toString().padStart(TOTP_DIGITS, '0')
}
