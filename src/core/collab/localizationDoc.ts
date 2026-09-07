import * as Y from 'yjs'
import {
  ContentLocalizationDraftInputSchema,
  type ContentLocalizationDraftInput,
  type LocaleTreeOverrides,
} from '@core/localization-schema'
import { parseLocaleTreeCell } from '@core/localization'
import { readComponentParameterValues } from '@core/visualComponents'
import { compiledCheck } from '@core/utils/typeboxCompiler'
import { deepEqual } from '@core/utils/deepEqual'
import { dataMap, metaMap, SEED_CLIENT_ID, SEED_ORIGIN, treeMap } from './schema'
import { own } from './nodeY'
import { applyTextDiff } from './textDiff'
import { localeNodeCellKey, readLocaleNodeCellKey } from './localizationKeys'

function mapAt(parent: Y.Map<unknown>, key: string): Y.Map<unknown> {
  const current = parent.get(key)
  if (current instanceof Y.Map) return current
  const map = new Y.Map<unknown>()
  parent.set(key, map)
  return map
}

function updateValueMap(
  map: Y.Map<unknown>,
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
  collaborativeText: boolean,
): void {
  for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    const hasNext = Object.hasOwn(next, key)
    if (hasNext === Object.hasOwn(previous, key) && deepEqual(previous[key], next[key])) continue
    if (!hasNext || next[key] === undefined) {
      map.delete(key)
      continue
    }
    const value = next[key]
    if (collaborativeText && typeof value === 'string') {
      const current = map.get(key)
      if (current instanceof Y.Text) applyTextDiff(current, current.toString(), value)
      else map.set(key, new Y.Text(value))
    } else {
      map.set(key, own(value))
    }
  }
}

function readValueMap(map: unknown): Record<string, unknown> {
  if (!(map instanceof Y.Map)) return {}
  return Object.fromEntries([...map.entries()].map(([key, value]) => [
    key, value instanceof Y.Text ? value.toString() : value instanceof Y.Map ? readValueMap(value) : own(value),
  ]))
}

function flatTreeValues(overrides: LocaleTreeOverrides): Record<string, unknown> {
  return Object.fromEntries(Object.entries(overrides).flatMap(([nodeId, node]) => {
    const values: [string, unknown][] = []
    if (node.hidden !== undefined) values.push([localeNodeCellKey(nodeId), node.hidden])
    for (const [property, value] of Object.entries(node.props ?? {})) {
      if (property === 'propOverrides') {
        for (const [parameter, parameterValue] of Object.entries(readComponentParameterValues(value))) {
          values.push([localeNodeCellKey(nodeId, property, parameter), parameterValue])
        }
      } else values.push([localeNodeCellKey(nodeId, property), value])
    }
    return values
  }))
}

function projectTreeOverrides(doc: Y.Doc): LocaleTreeOverrides {
  const nodes: LocaleTreeOverrides = Object.create(null)
  for (const [key, value] of Object.entries(readValueMap(treeMap(doc).get('nodes')))) {
    const [nodeId, property, parameter] = readLocaleNodeCellKey(key)
    const node = nodes[nodeId] ??= {}
    if (property === undefined) {
      // The full overlay is validated below, including this boolean value.
      Object.assign(node, { hidden: value })
    } else {
      const props = node.props ??= Object.create(null)
      if (parameter === undefined) props[property] = value
      else {
        if (property !== 'propOverrides') throw new Error('Invalid localized parameter property')
        const parameters = readComponentParameterValues(props[property])
        props[property] = { ...parameters, [parameter]: value }
      }
    }
  }
  return parseLocaleTreeCell({ nodes }).nodes
}

/** Apply only changed fields so independent peer edits and per-locale undo remain independent. */
export function applyLocalizationDraftToDoc(
  doc: Y.Doc,
  previous: ContentLocalizationDraftInput,
  next: ContentLocalizationDraftInput,
  origin: unknown,
): void {
  doc.transact(() => {
    if (previous.slug !== next.slug || !metaMap(doc).has('slug')) metaMap(doc).set('slug', next.slug)
    const previousCells = Object.fromEntries(Object.entries(previous.cells).filter(([key]) => key !== 'body' && key !== 'parameterDefaults'))
    const nextCells = Object.fromEntries(Object.entries(next.cells).filter(([key]) => key !== 'body' && key !== 'parameterDefaults'))
    updateValueMap(mapAt(dataMap(doc), 'cells'), previousCells, nextCells, true)
    updateValueMap(mapAt(dataMap(doc), 'parameterDefaults'), readComponentParameterValues(previous.cells.parameterDefaults), readComponentParameterValues(next.cells.parameterDefaults), true)
    updateValueMap(mapAt(dataMap(doc), 'translationMeta'), previous.translationMeta ?? {}, next.translationMeta ?? {}, false)
    // Keep a seeded map of independently addressed values, including when
    // everything inherits. Concurrent first edits may touch the same node.
    updateValueMap(mapAt(treeMap(doc), 'nodes'),
      flatTreeValues(parseLocaleTreeCell(previous.cells.body).nodes),
      flatTreeValues(parseLocaleTreeCell(next.cells.body).nodes), true)
  }, origin)
}

export function seedLocalizationDoc(doc: Y.Doc, draft: ContentLocalizationDraftInput): void {
  const clientId = doc.clientID
  doc.clientID = SEED_CLIENT_ID
  try {
    applyLocalizationDraftToDoc(doc, { cells: {}, slug: '' }, draft, SEED_ORIGIN)
  } finally {
    doc.clientID = clientId
  }
}

/** Validate the wire projection before any localized cells reach editor or storage. */
export function projectLocalizationDoc(doc: Y.Doc): ContentLocalizationDraftInput {
  const cells = readValueMap(dataMap(doc).get('cells'))
  const parameters = readValueMap(dataMap(doc).get('parameterDefaults'))
  if (Object.keys(parameters).length > 0) cells.parameterDefaults = parameters
  const nodes = projectTreeOverrides(doc)
  if (Object.keys(nodes).length > 0) cells.body = { nodes }
  const value = {
    cells,
    slug: metaMap(doc).get('slug') ?? '',
    translationMeta: readValueMap(dataMap(doc).get('translationMeta')),
  }
  if (!compiledCheck(ContentLocalizationDraftInputSchema, value)) throw new Error('Invalid localized collaboration document')
  return value
}
