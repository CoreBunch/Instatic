/**
 * Shapes of the bulk member calls: exporting every member, and importing
 * members from a file (`/admin/api/cms/members/export`, `/import/preview`,
 * `/import`). The file formats are described in docs/features/members.md →
 * "Export and import".
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'

export const MemberExportFormatSchema = Type.Union([Type.Literal('csv'), Type.Literal('json')])
export type MemberExportFormat = Static<typeof MemberExportFormatSchema>

/** The CSV columns, in order. The JSON export carries the same plus `profile`. */
export const MEMBER_CSV_COLUMNS = [
  'email',
  'name',
  'status',
  'email_confirmed',
  'tags',
  'created_at',
  'last_sign_in_at',
] as const

/** What a JSON export names itself, so an import can tell one apart. */
export const MEMBER_EXPORT_KIND = 'instatic.members'

/** Largest file an import accepts. */
export const MEMBER_IMPORT_MAX_BYTES = 5 * 1024 * 1024
/** Most rows one import accepts. A larger list is imported in parts. */
export const MEMBER_IMPORT_MAX_ROWS = 10_000
/** Most invitations one import sends. */
export const MEMBER_IMPORT_MAX_INVITATIONS = 500

/** The file name of an export of every member, dated. */
export function memberExportFilename(format: MemberExportFormat, at: Date = new Date()): string {
  return `members-${at.toISOString().slice(0, 10)}.${format}`
}

export const MemberImportRequestSchema = Type.Object(
  {
    format: MemberExportFormatSchema,
    /** The file's text. */
    content: Type.String({ maxLength: MEMBER_IMPORT_MAX_BYTES }),
    /**
     * What happens to an address that already has an account: `skip` leaves
     * it alone, `tags` gives it the row's tags (and the extra tags) and
     * changes nothing else.
     */
    existing: Type.Union([Type.Literal('skip'), Type.Literal('tags')]),
    /** Tags every imported row gets, on top of its own. */
    tags: Type.Array(Type.String({ maxLength: 64 }), { maxItems: 20 }),
    /** Email an invitation to every new member. */
    invite: Type.Boolean(),
  },
  { additionalProperties: false },
)
export type MemberImportRequest = Static<typeof MemberImportRequestSchema>

/** A row that cannot be imported, by its line in a CSV file or its position in a JSON list (from 1). */
export const MemberImportProblemSchema = Type.Object({
  row: Type.Integer(),
  email: Type.String(),
  reason: Type.String(),
})
export type MemberImportProblem = Static<typeof MemberImportProblemSchema>

export const MemberImportPreviewSchema = Type.Object({
  /** Rows read from the file. */
  rows: Type.Integer(),
  /** Addresses with no account: each becomes a member. */
  new: Type.Integer(),
  /** Addresses that already have an account: skipped, or given the tags. */
  existing: Type.Integer(),
  invalid: Type.Integer(),
  /** The first invalid rows, with the reason. */
  problems: Type.Array(MemberImportProblemSchema),
  /** Columns or profile keys in the file that are not imported. */
  ignored: Type.Array(Type.String()),
  /** Whether invitations can be sent; the reason when they cannot. */
  invitations: Type.Object({ available: Type.Boolean(), reason: Type.Optional(Type.String()) }),
})
export type MemberImportPreview = Static<typeof MemberImportPreviewSchema>

export const MemberImportPreviewResponseSchema = Type.Object({ preview: MemberImportPreviewSchema })

export const MemberImportResultSchema = Type.Object({
  /** New members, invited ones included. */
  created: Type.Integer(),
  /** New members who were sent an invitation. */
  invited: Type.Integer(),
  /** Existing members given at least one tag. */
  tagged: Type.Integer(),
  /** Existing members left as they were. */
  skipped: Type.Integer(),
  invalid: Type.Integer(),
  /** Rows that could not be saved. Importing the same file again picks them up. */
  failed: Type.Integer(),
  /** The first invalid and failed rows, with the reason. */
  problems: Type.Array(MemberImportProblemSchema),
})
export type MemberImportResult = Static<typeof MemberImportResultSchema>

export const MemberImportResultResponseSchema = Type.Object({ result: MemberImportResultSchema })
