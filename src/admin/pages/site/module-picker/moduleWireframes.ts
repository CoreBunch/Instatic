import type { NodeTree, PageNode } from '@core/page-tree'

type WireNodeKind =
  | 'box'
  | 'button'
  | 'check'
  | 'col'
  | 'dot'
  | 'field'
  | 'gap'
  | 'icon'
  | 'image'
  | 'lines'
  | 'pill'
  | 'radio'
  | 'row'
  | 'rule'

export interface WireNode {
  kind: WireNodeKind
  children?: WireNode[]
  count?: number
  width?: number
  height?: number
  flex?: number
  gap?: number
  pad?: number
  align?: 'start' | 'center' | 'end'
  avatar?: boolean
  bar?: boolean
  big?: boolean
  card?: boolean
  caret?: boolean
  center?: boolean
  code?: boolean
  dashed?: boolean
  link?: boolean
  logo?: boolean
  message?: boolean
  mono?: boolean
  play?: boolean
  solid?: boolean
  tip?: boolean
  vertical?: boolean
}

const row = (children: WireNode[], node: Partial<WireNode> = {}): WireNode => ({
  kind: 'row',
  children,
  ...node,
})

const col = (children: WireNode[], node: Partial<WireNode> = {}): WireNode => ({
  kind: 'col',
  children,
  ...node,
})

const box = (children: WireNode[] = [], node: Partial<WireNode> = {}): WireNode => ({
  kind: 'box',
  children,
  ...node,
})

const lines = (count = 3, node: Partial<WireNode> = {}): WireNode => ({
  kind: 'lines',
  count,
  ...node,
})

const field = (node: Partial<WireNode> = {}): WireNode => ({ kind: 'field', ...node })
const image = (node: Partial<WireNode> = {}): WireNode => ({ kind: 'image', ...node })
const button = (node: Partial<WireNode> = {}): WireNode => ({ kind: 'button', ...node })
const icon = (node: Partial<WireNode> = {}): WireNode => ({ kind: 'icon', ...node })
const dot = (node: Partial<WireNode> = {}): WireNode => ({ kind: 'dot', ...node })
const check = (node: Partial<WireNode> = {}): WireNode => ({ kind: 'check', ...node })
const radio = (node: Partial<WireNode> = {}): WireNode => ({ kind: 'radio', ...node })

export const MODULE_WIRES: Readonly<Record<string, WireNode>> = {
  'base.body': box([], { dashed: true, height: 52 }),
  'base.button': row([button({ width: 48 })], { center: true, align: 'center', height: 40 }),
  'base.checkbox': row([check(), lines(1, { flex: 1 })], { gap: 6, align: 'center' }),
  'base.container': box([], { dashed: true, height: 52 }),
  'base.outlet': col([lines(1, { big: true, width: 60 }), lines(3), image({ height: 30 }), lines(2)], { gap: 6 }),
  'base.form': col([field(), field(), button({ width: 40 })], { gap: 6 }),
  'base.form-message': box([row([icon(), lines(1, { flex: 1 })], { gap: 6, align: 'center' })], { pad: 6, message: true }),
  'base.image': image({ height: 52 }),
  'base.input': col([lines(1, { width: 28 }), field()], { gap: 4 }),
  'base.label': lines(1, { width: 34 }),
  'base.link': lines(1, { width: 44, link: true }),
  'base.list': col([
    row([dot(), lines(1, { flex: 1 })], { gap: 6, align: 'center' }),
    row([dot(), lines(1, { flex: 1 })], { gap: 6, align: 'center' }),
    row([dot(), lines(1, { flex: 1 })], { gap: 6, align: 'center' }),
  ], { gap: 6 }),
  'base.loop': col([
    row([image({ width: 18, height: 18 }), lines(2, { flex: 1 })], { gap: 6, align: 'center' }),
    row([image({ width: 18, height: 18 }), lines(2, { flex: 1 })], { gap: 6, align: 'center' }),
  ], { gap: 6 }),
  'base.option': col([lines(1, { width: 28 }), field({ caret: true })], { gap: 4 }),
  'base.option-group': col([lines(1, { width: 42 }), field({ caret: true })], { gap: 4 }),
  'base.radio': col([
    row([radio(), lines(1, { flex: 1 })], { gap: 6, align: 'center' }),
    row([radio(), lines(1, { flex: 1 })], { gap: 6, align: 'center' }),
  ], { gap: 6 }),
  'base.select': col([lines(1, { width: 28 }), field({ caret: true })], { gap: 4 }),
  'base.slot-instance': box([], { dashed: true, height: 42 }),
  'base.slot-outlet': box([lines(1, { width: 52, center: true })], { dashed: true, height: 44, center: true }),
  'base.submit': row([button({ width: 52, solid: true })], { center: true, height: 40 }),
  'base.svg': box([icon({ big: true })], { dashed: true, height: 52, center: true }),
  'base.text': lines(3),
  'base.textarea': col([lines(1, { width: 28 }), field({ height: 28 })], { gap: 4 }),
  'base.video': image({ height: 52, play: true }),
  'base.visual-component-ref': box([icon({ big: true }), lines(1, { width: 54, center: true })], {
    dashed: true,
    height: 52,
    center: true,
    gap: 6,
  }),
}

export const LAYOUT_WIRES = {
  cardGrid: row([
    col([image({ height: 30 }), lines(1, { width: 80 }), lines(2)], { gap: 5, flex: 1, pad: 4, card: true }),
    col([image({ height: 30 }), lines(1, { width: 80 }), lines(2)], { gap: 5, flex: 1, pad: 4, card: true }),
    col([image({ height: 30 }), lines(1, { width: 80 }), lines(2)], { gap: 5, flex: 1, pad: 4, card: true }),
  ], { gap: 10 }),
  cta: col([
    lines(1, { big: true, width: 64, center: true }),
    lines(2, { center: true }),
    row([button({ width: 44, solid: true }), button({ width: 44 })], { gap: 8, center: true }),
  ], { gap: 8, center: true, pad: 8, card: true }),
  featureGrid: col([
    col([lines(1, { big: true, width: 50, center: true }), lines(1, { width: 70, center: true })], { gap: 5, center: true }),
    row([
      col([icon({ big: true }), lines(1, { width: 70 }), lines(2)], { gap: 6, flex: 1, pad: 4 }),
      col([icon({ big: true }), lines(1, { width: 70 }), lines(2)], { gap: 6, flex: 1, pad: 4 }),
      col([icon({ big: true }), lines(1, { width: 70 }), lines(2)], { gap: 6, flex: 1, pad: 4 }),
    ], { gap: 10 }),
  ], { gap: 12 }),
  footer: row([
    col([box([icon()], { logo: true }), lines(2)], { gap: 6, flex: 1 }),
    col([lines(1, { width: 60 }), lines(1, { width: 80 }), lines(1, { width: 50 })], { gap: 5, flex: 1 }),
    col([lines(1, { width: 60 }), lines(1, { width: 80 }), lines(1, { width: 50 })], { gap: 5, flex: 1 }),
    col([lines(1, { width: 60 }), field()], { gap: 6, flex: 1 }),
  ], { gap: 14, pad: 4 }),
  heroSplit: row([
    col([
      lines(1, { big: true, width: 90 }),
      lines(1, { big: true, width: 60 }),
      lines(3),
      row([button({ width: 40, solid: true }), button({ width: 40 })], { gap: 8 }),
    ], { gap: 8, flex: 1.1, pad: 4 }),
    image({ flex: 1, height: 96 }),
  ], { gap: 12, align: 'center' }),
  stats: row([
    col([lines(1, { big: true, width: 60, center: true }), lines(1, { width: 80, center: true })], { gap: 5, flex: 1, center: true }),
    col([lines(1, { big: true, width: 60, center: true }), lines(1, { width: 80, center: true })], { gap: 5, flex: 1, center: true }),
    col([lines(1, { big: true, width: 60, center: true }), lines(1, { width: 80, center: true })], { gap: 5, flex: 1, center: true }),
    col([lines(1, { big: true, width: 60, center: true }), lines(1, { width: 80, center: true })], { gap: 5, flex: 1, center: true }),
  ], { gap: 12, pad: 6 }),
  twoColumn: row([
    col([lines(1, { big: true, width: 70 }), lines(4)], { gap: 6, flex: 1 }),
    col([lines(1, { big: true, width: 70 }), lines(4)], { gap: 6, flex: 1 }),
  ], { gap: 14 }),
}

export function moduleWireForId(moduleId: string, category?: string): WireNode {
  const known = MODULE_WIRES[moduleId]
  if (known) return known

  if (category === 'Forms') return MODULE_WIRES['base.form']
  if (category === 'Media') return MODULE_WIRES['base.image']
  if (category === 'Interactive') return MODULE_WIRES['base.button']
  if (category === 'Typography') return MODULE_WIRES['base.text']
  if (category === 'CMS') return MODULE_WIRES['base.outlet']
  return MODULE_WIRES['base.container']
}

export function wireFromTree(tree: NodeTree<PageNode>): WireNode {
  const root = tree.nodes[tree.rootNodeId]
  if (!root) return moduleWireForId('base.container')

  const children = root.children
    .map((childId) => tree.nodes[childId])
    .filter((node): node is PageNode => Boolean(node))
    .slice(0, 4)

  if (children.length === 0) return moduleWireForId(root.moduleId)

  return col(
    children.map((node) => {
      if (node.children.length > 0) return wireFromNode(tree, node.id)
      return moduleWireForId(node.moduleId)
    }),
    { gap: 6, pad: 4 },
  )
}

function wireFromNode(tree: NodeTree<PageNode>, nodeId: string): WireNode {
  const node = tree.nodes[nodeId]
  if (!node) return moduleWireForId('base.container')
  const children = node.children
    .map((childId) => tree.nodes[childId])
    .filter((child): child is PageNode => Boolean(child))
    .slice(0, 3)

  if (children.length === 0) return moduleWireForId(node.moduleId)

  return box(
    children.map((child) => moduleWireForId(child.moduleId)),
    { dashed: true, gap: 5, pad: 5 },
  )
}

