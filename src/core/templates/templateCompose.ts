import type { Page, PageNode } from '@core/page-tree'
import { reindexNodeParents } from '@core/page-tree'
import { firstOutletId, treeHasOutlet } from './outlet'

type TerminalContent =
  | { kind: 'page'; page: Page }
  | { kind: 'entry' }

type Nodes = Record<string, PageNode>

function hasMeaningfulBodyProps(node: PageNode): boolean {
  return Object.keys(node.props ?? {}).length > 0
    || Object.keys(node.breakpointOverrides ?? {}).length > 0
}

/** Clone a tree's nodes with every id prefixed, returning the remapped root id. */
function rekey(nodes: Nodes, rootId: string, prefix: string): { nodes: Nodes; rootId: string } {
  const map = new Map<string, string>()
  for (const id in nodes) map.set(id, `${prefix}${id}`)
  const out: Nodes = {}
  for (const id in nodes) {
    const n = nodes[id]
    out[map.get(id)!] = { ...n, id: map.get(id)!, children: n.children.map((c) => map.get(c) ?? c) }
  }
  return { nodes: out, rootId: map.get(rootId)! }
}

/**
 * Find the parent id + index of `childId` within `nodes`.
 *
 * Intentionally scans `children` rather than reading `node.parentId`: during
 * composition `rekey()` prefixes every node id, so any copied `parentId` points
 * at a pre-prefix id and is stale until `reindexNodeParents` runs at the end of
 * `composeTemplateChain`. This runs once per outlet (not a hot path), so the
 * scan is fine.
 */
function locate(nodes: Nodes, childId: string): { parentId: string; index: number } | null {
  for (const id in nodes) {
    const i = nodes[id].children.indexOf(childId)
    if (i !== -1) return { parentId: id, index: i }
  }
  return null
}

/**
 * Resolve the spliced content of an inner tree, mutating `nodes` if a wrapper
 * must be created:
 *  - inner root is base.body with NO meaningful props → splice its children
 *    directly (avoid a nested <body>, no needless wrapper);
 *  - inner root is base.body WITH props/breakpointOverrides → migrate those onto
 *    a fresh base.container wrapping its children, so body styling survives;
 *  - otherwise → the root itself.
 * Returns the ids to insert at the outlet position. The dropped base.body
 * wrapper is removed from `nodes` by the caller.
 */
function contentRootIds(nodes: Nodes, rootId: string, prefix: string): string[] {
  const root = nodes[rootId]
  if (root?.moduleId !== 'base.body') return [rootId]
  if (!hasMeaningfulBodyProps(root)) return [...root.children]
  // Migrate body-level styling onto a container so nothing is silently lost.
  const containerId = `${prefix}bodyprops`
  nodes[containerId] = {
    id: containerId,
    moduleId: 'base.container',
    props: { ...root.props },
    breakpointOverrides: { ...root.breakpointOverrides },
    children: [...root.children],
  } as PageNode
  return [containerId]
}

/**
 * Replace the first base.outlet in `host` with `inner`'s content nodes. The
 * host is guaranteed (by the caller) to contain at least one outlet; extra
 * outlets are left untouched and render empty.
 */
function spliceIntoOutlet(host: Nodes, hostRoot: string, inner: Nodes, innerRoot: string, prefix: string): { nodes: Nodes; rootId: string } {
  const outletId = firstOutletId(host)!
  const at = locate(host, outletId)
  const rekeyed = rekey(inner, innerRoot, prefix)
  const merged: Nodes = { ...host, ...rekeyed.nodes }
  const contentIds = contentRootIds(merged, rekeyed.rootId, prefix)
  delete merged[outletId]
  // If the inner root was base.body, that wrapper node is now orphaned — drop it.
  if (rekeyed.nodes[rekeyed.rootId]?.moduleId === 'base.body') delete merged[rekeyed.rootId]
  if (at) {
    const parent = merged[at.parentId]
    merged[at.parentId] = {
      ...parent,
      children: [...parent.children.slice(0, at.index), ...contentIds, ...parent.children.slice(at.index + 1)],
    }
  }
  return { nodes: merged, rootId: hostRoot }
}

/**
 * Merge an ordered (outer→inner) template chain + terminal into one Page.
 *
 * Templates with no `base.outlet` cannot host content, so they are an
 * unfinished/no-op template and are skipped — never an error. With every
 * outlet-less template filtered out:
 *  - page terminal, empty effective chain → the page renders as-is;
 *  - entry terminal, empty effective chain → the innermost template renders as
 *    chrome only (no body) until the author adds an outlet.
 */
export function composeTemplateChain(chain: Page[], terminal: TerminalContent): Page {
  const effective = chain.filter(treeHasOutlet)

  if (effective.length === 0) {
    if (terminal.kind === 'page') return terminal.page
    // entry terminal with no usable outlet anywhere: render the innermost
    // matched template as-is (chrome without a body). `chain` is non-empty here
    // because the renderer 404s an entry route with no matching template.
    const t = chain[chain.length - 1]
    return { id: t.id, slug: t.slug, title: t.title, rootNodeId: t.rootNodeId, nodes: { ...t.nodes } }
  }

  // Build the merged tree from the INNERMOST effective template outward.
  const innermost = effective[effective.length - 1]
  let acc: { nodes: Nodes; rootId: string } = { nodes: { ...innermost.nodes }, rootId: innermost.rootNodeId }

  // Innermost terminal handling.
  if (terminal.kind === 'page') {
    acc = spliceIntoOutlet(acc.nodes, acc.rootId, terminal.page.nodes, terminal.page.rootNodeId, 'c0_')
  }
  // entry terminal: leave the innermost outlet in place (renders currentEntry.body).

  // Wrap with each outer template, inner-most-but-one first.
  for (let i = effective.length - 2; i >= 0; i--) {
    const outer = effective[i]
    acc = spliceIntoOutlet({ ...outer.nodes }, outer.rootNodeId, acc.nodes, acc.rootId, `t${i}_`)
  }

  // The merged tree rekeys node ids (prefixing) and splices subtrees across
  // outlets, so any parentId copied from the source pages is now stale. Derive
  // it fresh from the composed children arrays before the page is rendered
  // (the publisher's sizes resolver reads parentId).
  reindexNodeParents(acc.nodes)

  return {
    id: innermost.id, // identifies "what was rendered" for the publish.html filter
    slug: innermost.slug,
    title: innermost.title,
    rootNodeId: acc.rootId,
    nodes: acc.nodes,
  }
}
