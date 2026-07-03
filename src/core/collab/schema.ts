/**
 * Y-document layout shared by every collab doc kind, plus transaction
 * origins and the inline-text lookup.
 *
 * Layouts (see docs/plans/2026-07-03-collab-crdt-coediting.md):
 *   page/component docs → getMap('meta') + getMap('tree')
 *     tree: { rootNodeId: string, nodes: Y.Map<nodeId, node Y.Map> }
 *     node: { props: Y.Map (inline-text prop as Y.Text),
 *             breakpointOverrides: Y.Map<bp, Y.Map>, children: Y.Array<string>,
 *             every other node field a plain LWW value; parentId NEVER stored }
 *   layout docs → getMap('meta') + getMap('data') { snapshot: plain JSON }
 *   site doc    → getMap('shell') + getMap('rosters')
 *
 * Origins tag every transaction so observers and the UndoManager can tell
 * who caused a change:
 *   LOCAL_ORIGIN     — this user's edits (undoable)
 *   REMOTE_ORIGIN    — updates applied from the wire (never undoable)
 *   RECONCILE_ORIGIN — derived corrections (slot sync, integrity) that run
 *                      identically on every peer (never undoable)
 *   SEED_ORIGIN      — initial construction from persisted JSON
 */
import * as Y from 'yjs'
import { registry } from '@core/module-engine'

export const LOCAL_ORIGIN = Symbol('collab-local')
export const REMOTE_ORIGIN = 'collab-remote'
export const RECONCILE_ORIGIN = 'collab-reconcile'
export const SEED_ORIGIN = 'collab-seed'

/** Deterministic clientID for seeding — the server is the only seeder. */
export const SEED_CLIENT_ID = 1

export const treeMap = (doc: Y.Doc): Y.Map<unknown> => doc.getMap<unknown>('tree')
export const metaMap = (doc: Y.Doc): Y.Map<unknown> => doc.getMap<unknown>('meta')
export const dataMap = (doc: Y.Doc): Y.Map<unknown> => doc.getMap<unknown>('data')
export const shellMap = (doc: Y.Doc): Y.Map<unknown> => doc.getMap<unknown>('shell')
export const rostersMap = (doc: Y.Doc): Y.Map<unknown> => doc.getMap<unknown>('rosters')

/**
 * The one prop of a module stored as Y.Text (character-level merge).
 * Resolved from the module registry — callers must have registered modules
 * (`import '@modules/base'`); unregistered modules degrade to plain-string
 * props, which still merge whole-value LWW.
 */
export function inlineTextPropOf(moduleId: string): string | null {
  return registry.get(moduleId)?.inlineTextEdit?.prop ?? null
}
