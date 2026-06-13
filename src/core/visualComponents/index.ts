/**
 * Visual Components — public barrel.
 *
 * Schemas (TypeBox source of truth), instantiation at refs, slot
 * synchronization, name/param validation, recursion guarding, deletion-impact
 * analysis, param-origin lookup, and virtual-page flattening for the editor.
 *
 * External consumers import from `@core/visualComponents`. Files inside this
 * module import each other via relative paths, never through this barrel.
 */

export { VisualComponentSchema, parseVisualComponent } from './schemas'
export type { VisualComponent, VCNode, VCParam, VCParamType } from './schemas'

export { instantiateVCAtRef } from './instantiate'
export type { InstantiatedVCNode } from './instantiate'

export { validateComponentName, validateParamName, vcSlugFromName } from './nameValidation'

export { getReferencedComponentIds, wouldCreateCycle } from './recursionGuard'

export { forEachVCRef, collectVCRefs } from './vcRefs'


export { collectSlotOutletNames, syncSlotInstances, applySlotSyncResult } from './slotSync'

export { previewVCDeletion } from './deletionImpact'
export type { VCDeletionImpact, VCRefUsage } from './deletionImpact'

export { findParamOrigin } from './origin'

export { flattenVCToVirtualPage, parseVirtualVCPageId } from './virtualPage'

export { resolveSlotName, safePropOverrides } from './propGuards'
