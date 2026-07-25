/**
 * @core/collab — the CRDT collaboration engine (Yjs).
 *
 * One Y document per logical row/shell; JSON⇄Y seeding + projection;
 * Mutative-patch → Y translation; deterministic integrity reconciles.
 * Consumed by the editor store (write path + mirror), the server relay
 * (seed/persist), and the wire protocol. Barrel-gated: import ONLY from
 * `@core/collab` outside this folder.
 */
export {
  encodeCollabDocId,
  parseCollabDocId,
  SITE_DOC_ID,
  type CollabDocId,
  type CollabDocKind,
} from './docIds'
export {
  dataMap,
  LOCAL_ORIGIN,
  metaMap,
  REMOTE_ORIGIN,
  rostersMap,
  SEED_CLIENT_ID,
  SEED_ORIGIN,
  shellMap,
  treeMap,
} from './schema'
export { reconcileTreeIntegrity } from './integrity'
export { applyTextDiff } from './textDiff'
export {
  decodeCollabFrame,
  decodeResetReason,
  encodeCollabFrame,
  encodeResetPayload,
  FRAME_AWARENESS,
  FRAME_RESET,
  FRAME_SYNC,
  PRESENCE_DOC_ID,
  SITE_SOCKET_PATH,
  type CollabFrame,
  type ResetReason,
} from './protocol'
export { createCollabDocSet, type CollabDocSet } from './docSet'
export { applySitePatchesToDocs } from './applyPatches'
export {
  populateComponentDoc,
  populateLayoutDoc,
  populatePageDoc,
  seedComponentDoc,
  seedLayoutDoc,
  seedPageDoc,
  seedSiteDoc,
  seedSiteDocFromParts,
  type SiteDocRosterIds,
} from './seed'
export {
  projectComponentDoc,
  projectLayoutDoc,
  projectPageDoc,
  projectSiteDoc,
  type ProjectedSiteDoc,
} from './project'
