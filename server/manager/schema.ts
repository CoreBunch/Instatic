/**
 * Request bodies of the Manager API. The matching client lives in Instatic
 * Desktop (`src-tauri/src/remote.rs`); the wire contract is documented in
 * `docs/features/manager-api.md`.
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'

const Sha256Schema = Type.String({ pattern: '^[0-9a-f]{64}$' })
const SizeSchema = Type.Integer({ minimum: 0 })

export const TransferFileSchema = Type.Object({
  path: Type.String({ minLength: 1, maxLength: 1024 }),
  sizeBytes: SizeSchema,
  sha256: Sha256Schema,
})
export type TransferFile = Static<typeof TransferFileSchema>

export const OpenTransferSchema = Type.Object({
  source: Type.Object({
    version: Type.String({ minLength: 1, maxLength: 64 }),
    migrations: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 10000 }),
    secretKeyFingerprint: Type.Optional(Type.Union([Type.String({ maxLength: 200 }), Type.Null()])),
  }),
  database: Type.Object({ sizeBytes: SizeSchema, sha256: Sha256Schema }),
  files: Type.Array(TransferFileSchema, { maxItems: 200000 }),
  allowSecretKeyMismatch: Type.Optional(Type.Boolean()),
})
export type OpenTransferBody = Static<typeof OpenTransferSchema>

export const CommitTransferSchema = Type.Object({
  restart: Type.Optional(Type.Boolean()),
  revokeSessions: Type.Optional(Type.Boolean()),
})

export const RestoreSnapshotSchema = Type.Object({
  restart: Type.Optional(Type.Boolean()),
  revokeSessions: Type.Optional(Type.Boolean()),
})
