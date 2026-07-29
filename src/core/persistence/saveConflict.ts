/**
 * Save-conflict protocol shapes — shared by the transactional save endpoint
 * (server) and the CMS persistence adapter (client).
 *
 * An incremental site-document save carries base seqs: for every changed or
 * deleted row, the site-global sync seq the client last synchronized with
 * (seeded at load, bumped on every successful save). Inside the save
 * transaction the server compares each shipped row's STORED seq against its
 * base seq; any stored row that is newer — or that the client has no base for
 * at all — means the save would silently overwrite another admin's work, so
 * the whole save is rejected with 409 and this envelope. Nothing is written.
 *
 * The shell participates coarsely: one seq for the whole shell (settings +
 * style rules + files), checked only when the incoming shell actually differs
 * from the stored one. `table: 'site'` conflicts carry the draft-site row id
 * (`'default'`).
 *
 * The same `SaveConflictError` class is thrown on both sides: the server
 * handler throws it out of the transaction (caught and turned into the 409
 * response), and the client adapter re-throws it after parsing the 409 body —
 * so editor code has exactly one typed error to branch on.
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'

export const SaveConflictSchema = Type.Object({
  /** Which collection conflicted; `'site'` is the shell (rowId `'default'`). */
  table: Type.Union([
    Type.Literal('site'),
    Type.Literal('pages'),
    Type.Literal('components'),
    Type.Literal('layouts'),
  ]),
  rowId: Type.String(),
  /** The STORED row's seq — the newer version the save would have overwritten. */
  seq: Type.Number(),
})

export type SaveConflict = Static<typeof SaveConflictSchema>

/** 409 response body of PUT /admin/api/cms/site-document. */
export const SaveConflictsEnvelopeSchema = Type.Object(
  {
    error: Type.String(),
    conflicts: Type.Array(SaveConflictSchema),
  },
  { additionalProperties: true },
)

export class SaveConflictError extends Error {
  readonly conflicts: SaveConflict[]

  constructor(conflicts: SaveConflict[]) {
    super('Another admin saved a newer version of content in this save')
    this.name = 'SaveConflictError'
    this.conflicts = conflicts
  }
}
