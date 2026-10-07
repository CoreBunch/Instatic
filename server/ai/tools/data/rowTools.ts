/**
 * Row read/write tools for reusable data tables.
 *
 * The `content_*` toolset writes a row by driving the open Content workspace
 * through the editor bridge, because a post's body is a Tiptap document only
 * the editor can render. A `kind: 'data'` row has no body — it is a bag of
 * typed cells edited in a grid — so routing its writes through a browser tab
 * would buy nothing and would make the whole toolset unusable from a headless
 * agent. These run in-process instead, reusing the same repository calls,
 * plugin filters, slug derivation, and access predicates the HTTP row
 * endpoints use, so a write over MCP and a write from the Data workspace
 * cannot diverge.
 *
 * Creates are bulk by default: `createDataRowMany` puts the whole batch in one
 * transaction, so an agent seeding a table either gets every row or none, and
 * never a half-filled table it has to reconcile by hand.
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'
import type { CoreCapability } from '@core/capabilities'
import type { DataRow } from '@core/data/schemas'
import { slugForTable } from '@core/data/cells'
import { DataCreateRowsOutputSchema, DataUpdateRowOutputSchema } from '@core/ai'
import { protectedBuiltInCreateCellKey } from '@core/data/systemTableGuard'
import type { AiTool, ToolContext } from '../../runtime/types'
import { createAuditEvent, type AuditAction } from '../../../repositories/audit'
import {
  createDataRowMany,
  getDataRowBySlug,
  getDataTable,
  saveDataRowDraft,
} from '../../../repositories/data'
import {
  applyContentEntryCellsFilter,
  emitContentEntryCreated,
  emitContentEntryUpdated,
} from '../../../publish/contentEvents'
import { canEditDataRow, canReadTable } from '../../../handlers/cms/data/access'
import { loadRowForTool, toolActor } from './access'
import type { DataToolsRuntime } from './runtime'

/** Mirrors `requireDataCreator` — creating a row is one capability, not a family. */
const ROW_CREATE_CAPS: CoreCapability[] = ['content.create']

/** Mirrors `DATA_EDIT_CAPABILITIES`; the per-row owner check runs in the handler. */
const ROW_EDIT_CAPS: CoreCapability[] = ['content.edit.own', 'content.edit.any', 'content.manage']

/**
 * One transaction's worth of rows. High enough that seeding a real catalogue
 * is a single call, low enough that a runaway generation cannot hold the write
 * lock (`serializeCollabAwareWrite`) for an unbounded stretch.
 */
const MAX_ROWS_PER_CALL = 200

const CellsSchema = Type.Record(Type.String(), Type.Unknown(), {
  description: 'Cell values keyed by field id. Field ids come from content_get_collection_schema.',
})

// ---------------------------------------------------------------------------
// data_create_rows
// ---------------------------------------------------------------------------

const CreateRowsInput = Type.Object({
  tableId: Type.String({ minLength: 1 }),
  rows: Type.Array(Type.Object({ cells: CellsSchema }, { additionalProperties: false }), {
    minItems: 1,
    maxItems: MAX_ROWS_PER_CALL,
  }),
}, { additionalProperties: false })

function createRowsTool(runtime?: DataToolsRuntime): AiTool {
  return {
    name: 'data_create_rows',
    scope: 'data',
    execution: 'server',
    mutates: true,
    requiredCapabilities: ROW_CREATE_CAPS,
    description:
      `Create up to ${MAX_ROWS_PER_CALL} rows in one table, in a single transaction — if any row is rejected, none are written. Cells are keyed by field id — call content_get_collection_schema with the table id for its field ids. Rows land as drafts; publish them with data_set_rows_status and read them back with content_list_documents. Headless — no editor needed.`,
    inputSchema: CreateRowsInput,
    outputSchema: DataCreateRowsOutputSchema,
    handler: async (input, ctx: ToolContext) => {
      const args = input as Static<typeof CreateRowsInput>
      const table = await getDataTable(ctx.db, ctx.branch, args.tableId)
      if (!table || !canReadTable(toolActor(ctx), table)) {
        return { ok: false, error: `Table ${args.tableId} not found.` }
      }

      const prepared: Array<{ cells: Record<string, unknown>; slug: string }> = []
      // Slugs are checked against the batch as well as against the table: the
      // unique index would otherwise abort the transaction mid-way with a
      // driver error, leaving the caller no way to tell which row caused it.
      const batchSlugs = new Set<string>()

      for (const [index, row] of args.rows.entries()) {
        const locked = protectedBuiltInCreateCellKey(table, row.cells)
        if (locked) {
          return {
            ok: false,
            error: `Row ${index}: the "${locked}" field is managed by the editor and can't be set here.`,
          }
        }

        const cells = await applyContentEntryCellsFilter(row.cells, {
          tableSlug: table.slug,
          entryId: 'new',
          actor: { kind: 'user', userId: ctx.userId },
        })
        const slug = slugForTable(table, cells)

        if (slug) {
          if (batchSlugs.has(slug)) {
            return { ok: false, error: `Row ${index}: slug "${slug}" is used twice in this batch.` }
          }
          const clash = await getDataRowBySlug(ctx.db, ctx.branch, table.id, slug)
          if (clash) {
            return {
              ok: false,
              error: `Row ${index}: a row with slug "${slug}" already exists in this table (id ${clash.id}).`,
            }
          }
          batchSlugs.add(slug)
        }

        prepared.push({ cells, slug })
      }

      const created = await createDataRowMany(
        ctx.db,
        ctx.branch,
        prepared.map((row) => ({ tableId: table.id, cells: row.cells, slug: row.slug })),
        ctx.userId,
      )

      for (const row of created) {
        await emitContentEntryCreated(ctx.db, ctx.branch, row.id, { kind: 'user', userId: ctx.userId })
        await recordRowAudit(ctx, runtime, 'data.row.create', row)
      }

      return { rows: created.map(projectRow) }
    },
  }
}

// ---------------------------------------------------------------------------
// data_update_row
// ---------------------------------------------------------------------------

const UpdateRowInput = Type.Object({
  rowId: Type.String({ minLength: 1 }),
  cells: CellsSchema,
  merge: Type.Optional(Type.Boolean({
    description: 'Default true: patch only the cells given. Set false to replace the whole cell set.',
  })),
}, { additionalProperties: false })

function updateRowTool(runtime?: DataToolsRuntime): AiTool {
  return {
    name: 'data_update_row',
    scope: 'data',
    execution: 'server',
    mutates: true,
    requiredCapabilities: ROW_EDIT_CAPS,
    description:
      "Change one row's cells. By default the given cells are merged into what is already stored, so you can set a single field without re-sending the rest; pass merge: false to replace the whole cell set. Editing a published row writes its draft — call data_set_rows_status to publish the change. Headless — no editor needed.",
    inputSchema: UpdateRowInput,
    outputSchema: DataUpdateRowOutputSchema,
    handler: async (input, ctx: ToolContext) => {
      const args = input as Static<typeof UpdateRowInput>
      const loaded = await loadRowForTool(ctx, args.rowId, canEditDataRow)
      if (!loaded) return { ok: false, error: `Row ${args.rowId} not found.` }
      const { row: current, table } = loaded

      const rawCells = args.merge === false ? args.cells : { ...current.cells, ...args.cells }
      const cells = await applyContentEntryCellsFilter(rawCells, {
        tableSlug: table.slug,
        entryId: current.id,
        actor: { kind: 'user', userId: ctx.userId },
      })
      const slug = slugForTable(table, cells)

      if (slug && slug !== current.slug) {
        const clash = await getDataRowBySlug(ctx.db, ctx.branch, table.id, slug)
        if (clash && clash.id !== current.id) {
          return {
            ok: false,
            error: `A row with slug "${slug}" already exists in this table (id ${clash.id}).`,
          }
        }
      }

      const row = await saveDataRowDraft(ctx.db, ctx.branch, current.id, { cells, slug }, ctx.userId)
      if (!row) return { ok: false, error: `Row ${args.rowId} not found.` }

      // Plugins loop-guard on this list, so it must include the keys the
      // filter itself rewrote, not only the keys the caller sent.
      const changedIds = [...new Set([
        ...Object.keys(args.cells),
        ...Object.keys(cells).filter((key) => cells[key] !== rawCells[key]),
      ])]
      await emitContentEntryUpdated(ctx.db, ctx.branch, row.id, changedIds, { kind: 'user', userId: ctx.userId })
      await recordRowAudit(ctx, runtime, 'data.row.update', row)

      return { row: projectRow(row) }
    },
  }
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

/**
 * What a caller needs back to keep working: the id to address the row with,
 * its slug and status, and the cells as they were actually stored — a plugin
 * filter may have normalized or auto-filled them.
 */
function projectRow(row: DataRow) {
  return {
    id: row.id,
    tableId: row.tableId,
    slug: row.slug,
    status: row.status,
    cells: row.cells,
    updatedAt: row.updatedAt,
  }
}

async function recordRowAudit(
  ctx: ToolContext,
  runtime: DataToolsRuntime | undefined,
  action: AuditAction,
  row: Pick<DataRow, 'id' | 'tableId' | 'slug'>,
): Promise<void> {
  await createAuditEvent(ctx.db, {
    actorUserId: ctx.userId,
    action,
    targetType: 'data_row',
    targetId: row.id,
    metadata: runtime?.connectorId
      ? { tableId: row.tableId, slug: row.slug, source: 'mcp', connectorId: runtime.connectorId }
      : { tableId: row.tableId, slug: row.slug, source: 'agent' },
  })
}

export function dataRowTools(runtime?: DataToolsRuntime): AiTool[] {
  return [createRowsTool(runtime), updateRowTool(runtime)]
}
