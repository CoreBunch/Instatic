import { Type, type Static } from '@core/utils/typeboxHelpers'
import { VisualComponentSchema } from '@core/visualComponents'
import { SavedLayoutSchema } from '@core/layouts'

export const SiteDocumentBodySchema = Type.Object({
  mode: Type.Union([Type.Literal('incremental'), Type.Literal('replace')]),
  // The shell — validated structurally by validateSite in phase 1.
  site: Type.Unknown(),
  // Pages are parsed/validated by validatePagesForPartialSave.
  changedPages: Type.Array(Type.Unknown()),
  deletedPageIds: Type.Array(Type.String()),
  changedComponents: Type.Array(VisualComponentSchema),
  deletedComponentIds: Type.Array(Type.String()),
  changedLayouts: Type.Array(SavedLayoutSchema),
  deletedLayoutIds: Type.Array(Type.String()),
  /**
   * Conflict detection (incremental mode): rowId → the stored seq the client
   * last synchronized with, for every changed AND deleted row. Inside the
   * save transaction, a stored row that is NEWER than its base — or that has
   * no base entry at all — 409s the whole save with a conflicts payload
   * (see @core/persistence/saveConflict). Client-created rows have no stored
   * counterpart and pass by construction. Ignored in replace mode (imports
   * are deliberate replace-everything operations).
   */
  baseSeqs: Type.Record(Type.String(), Type.Number()),
  /**
   * The shell seq the client last synchronized with. Checked only when the
   * incoming shell content actually differs from the stored shell — the
   * shell is shipped with every save, so an unconditional check would 409
   * every concurrent save pair. Ignored in replace mode.
   */
  shellBaseSeq: Type.Number(),
}, { additionalProperties: false })

export type SiteDocumentBody = Static<typeof SiteDocumentBodySchema>
