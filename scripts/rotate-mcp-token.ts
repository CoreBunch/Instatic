#!/usr/bin/env bun
/**
 * Rotate the local development MCP connector token without printing either the
 * old or new bearer secret.
 *
 * The admin endpoint deliberately returns a connector token only once. This
 * helper uses the same generator and repository path for operators who need to
 * rotate a local token after it has been exposed, while keeping the operation
 * scoped to the SQLite development database and the ignored `.env` file.
 *
 * Usage:
 *
 *   bun run scripts/rotate-mcp-token.ts
 *
 * The current `INSTATIC_MCP_TOKEN` is read from `.env`. The replacement is
 * written there with mode 0600. The old database row is deleted after the
 * replacement row is inserted, so its hash cannot remain usable or linger in
 * a revoked row.
 */

import { chmod, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createConnector, findConnectorByTokenHash } from '../server/ai/mcp/connectors/store'
import { generateConnectorToken, hashConnectorToken } from '../server/ai/mcp/connectors/token'
import { createDbClient, isSqliteUrl } from '../server/db'
import { readServerConfig } from '../server/config'

const ENV_FILE = join(import.meta.dir, '..', '.env')
const PRIVATE_FILE_MODE = 0o600
const TOKEN_ASSIGNMENT_RE = /^[ \t]*(?:export[ \t]+)?INSTATIC_MCP_TOKEN[ \t]*=/

function fail(message: string): never {
  throw new Error(`[rotate-mcp-token] ${message}`)
}

function readToken(envText: string): string {
  const match = envText.match(/^[ \t]*(?:export[ \t]+)?INSTATIC_MCP_TOKEN[ \t]*=[ \t]*([^\r\n]*)$/m)
  const raw = match?.[1]?.trim()
  if (!raw) fail(`INSTATIC_MCP_TOKEN is missing from ${ENV_FILE}`)

  if (
    raw.length >= 2 &&
    ((raw.startsWith('"') && raw.endsWith('"')) ||
      (raw.startsWith("'") && raw.endsWith("'")))
  ) {
    return raw.slice(1, -1)
  }
  return raw
}

function replaceToken(envText: string, token: string): string {
  const lineEnding = envText.includes('\r\n') ? '\r\n' : '\n'
  const lines = envText.split(/\r?\n/)
  let replaced = false
  const output: string[] = []

  for (const line of lines) {
    if (TOKEN_ASSIGNMENT_RE.test(line)) {
      if (!replaced) {
        output.push(`INSTATIC_MCP_TOKEN=${token}`)
        replaced = true
      }
      continue
    }
    output.push(line)
  }

  if (!replaced) fail(`INSTATIC_MCP_TOKEN is missing from ${ENV_FILE}`)
  return output.join(lineEnding)
}

async function writePrivateEnv(contents: string): Promise<void> {
  const temporaryFile = `${ENV_FILE}.${crypto.randomUUID()}.tmp`
  try {
    await writeFile(temporaryFile, contents, { encoding: 'utf8', mode: PRIVATE_FILE_MODE })
    await chmod(temporaryFile, PRIVATE_FILE_MODE)
    await rename(temporaryFile, ENV_FILE)
    await chmod(ENV_FILE, PRIVATE_FILE_MODE)
  } finally {
    await unlink(temporaryFile).catch(() => {})
  }
}

const originalEnv = await readFile(ENV_FILE, 'utf8').catch(() => fail(`cannot read ${ENV_FILE}`))
const oldToken = readToken(originalEnv)
const config = readServerConfig()
if (!isSqliteUrl(config.databaseUrl)) {
  fail('refusing to rotate a non-SQLite DATABASE_URL; this helper is local-development-only')
}

const oldHash = await hashConnectorToken(oldToken)
const newToken = generateConnectorToken()
const newHash = await hashConnectorToken(newToken)
const { db } = createDbClient(config.databaseUrl)
const oldConnector = await findConnectorByTokenHash(db, oldHash)
if (!oldConnector) fail('the token in .env does not resolve to an active MCP connector')

// Update the ignored local secret first. If the database transaction fails,
// restore the original file so a failed rotation does not strand the operator.
await writePrivateEnv(replaceToken(originalEnv, newToken))
let committed = false

try {
  const replacement = await db.transaction(async (tx) => {
    const created = await createConnector(tx, {
      userId: oldConnector.userId,
      label: `${oldConnector.label} (rotated)`,
      type: oldConnector.type,
      capabilities: oldConnector.capabilities,
      tokenHash: newHash,
      ttlDays: 90,
    })

    const deleted = await tx`
      delete from ai_mcp_connectors
      where id = ${oldConnector.id} and token_hash = ${oldHash}
    `
    if (deleted.rowCount !== 1) throw new Error('the old connector changed during rotation')

    // Verify inside the transaction. This prevents a post-commit verification
    // failure from restoring the old .env value after the old row is gone.
    const [{ rows: newRows }, { rows: oldRows }] = await Promise.all([
      tx`
        select id from ai_mcp_connectors where token_hash = ${newHash} and revoked_at is null
      `,
      tx`select id from ai_mcp_connectors where token_hash = ${oldHash}`,
    ])
    if (newRows.length !== 1 || oldRows.length !== 0) {
      throw new Error('post-rotation hash verification failed')
    }

    return created
  })
  committed = true

  console.log(`[rotate-mcp-token] rotated connector ${oldConnector.id} -> ${replacement.id}`)
  console.log(`[rotate-mcp-token] replacement written to ${ENV_FILE} (mode 0600)`)
  // The new bearer token is shown to the operator exactly once, mirroring the
  // admin endpoint. Anyone rerunning this script will see a fresh value; the
  // stored hash cannot be reversed into the plaintext.
  console.log(`[rotate-mcp-token] new INSTATIC_MCP_TOKEN=${newToken}`)
} catch (error) {
  // A transaction callback failure rolls back. Only restore the old file when
  // the database still proves that rollback happened; never overwrite the new
  // secret after an ambiguous database outcome.
  if (!committed) {
    try {
      const [{ rows: newRows }, { rows: oldRows }] = await Promise.all([
        db`
          select id from ai_mcp_connectors where token_hash = ${newHash} and revoked_at is null
        `,
        db`select id from ai_mcp_connectors where token_hash = ${oldHash}`,
      ])
      if (newRows.length === 0 && oldRows.length === 1) {
        await writePrivateEnv(originalEnv)
      } else {
        console.error('[rotate-mcp-token] database outcome is ambiguous; leaving the replacement in .env')
      }
    } catch (restoreError) {
      console.error('[rotate-mcp-token] could not verify rollback or restore .env:', restoreError)
    }
  }
  throw error
}
