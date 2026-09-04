/**
 * @core/cssProjection — the God Mode CSS panel's engine: style rules → an
 * annotated stylesheet text (`projectStylesheet`) and edited text → a
 * registry edit plan (`planStylesheetEdit`). Pure; no store, no DOM.
 */
export { projectStylesheet, ELEMENT_BLOCK_SELECTOR } from './projectStylesheet'
export type {
  StylesheetBlockInput,
  StylesheetBlockOrigin,
  StylesheetInlineBlockInput,
  StylesheetProjection,
  StylesheetProjectionBlock,
  StylesheetProjectionInput,
  StylesheetRuleBlockInput,
} from './types'
export { planStylesheetEdit } from './planStylesheetEdit'
export type { StylesheetEdit, StylesheetEditPlan, StylesheetEditPlanInput } from './planStylesheetEdit'
export { collectSiteCustomProperties } from './customProperties'
export type { SiteCustomProperty } from './customProperties'
