/**
 * The site pages behind Member settings. A setting names a page by id; this
 * module turns the ids into live addresses and lists the pages an owner can
 * pick from.
 */
import type { DbClient } from '../db/client'
import { pagePublicPath } from '@core/page-tree'
import { Type, safeParseValue } from '@core/utils/typeboxHelpers'
import {
  parseAccessRule,
  type MemberPageKey,
  type MemberPageOption,
  type MemberPagePaths,
  type MemberPages,
} from '@core/members'
import { listPageAddresses, type PageAddressRow } from '../repositories/publish'
import { getMemberSettings } from './repository'

/** The parts of a page row's cells this module reads. */
const PageCellsSchema = Type.Object({
  title: Type.Optional(Type.String()),
  templateEnabled: Type.Optional(Type.Boolean()),
  access: Type.Optional(Type.Unknown()),
  body: Type.Optional(
    Type.Object({
      nodes: Type.Record(
        Type.String(),
        Type.Object({ moduleId: Type.String(), props: Type.Optional(Type.Record(Type.String(), Type.Unknown())) }),
      ),
    }),
  ),
})

function publishedPath(row: PageAddressRow): string | null {
  return row.publishedSlug === null ? null : pagePublicPath(row.publishedSlug)
}

/** Every ordinary page (templates are not addresses), for the page pickers. */
export async function listMemberPageOptions(db: DbClient): Promise<MemberPageOption[]> {
  const options: MemberPageOption[] = []
  for (const row of await listPageAddresses(db)) {
    const parsed = safeParseValue(PageCellsSchema, row.cells)
    const cells = parsed.ok ? parsed.value : {}
    if (cells.templateEnabled) continue
    const formActions = new Set<string>()
    for (const node of Object.values(cells.body?.nodes ?? {})) {
      const action = node.props?.memberAction
      if (node.moduleId === 'base.form' && node.props?.mode === 'member' && typeof action === 'string') {
        formActions.add(action)
      }
    }
    options.push({
      id: row.id,
      title: cells.title || row.slug,
      path: pagePublicPath(row.slug),
      publishedPath: publishedPath(row),
      formActions: [...formActions],
      membersOnly: parseAccessRule(cells.access).level !== 'public',
    })
  }
  return options
}

/**
 * The live address of each assigned page. A page that is unpublished or
 * deleted has none, which switches its feature off like an unset one.
 */
export async function resolveMemberPagePaths(db: DbClient, pages: MemberPages): Promise<MemberPagePaths> {
  const assigned = Object.entries(pages).filter((entry): entry is [MemberPageKey, string] => Boolean(entry[1]))
  if (assigned.length === 0) return {}
  const live = new Map<string, string>()
  for (const row of await listPageAddresses(db)) {
    const path = publishedPath(row)
    if (path) live.set(row.id, path)
  }
  const paths: MemberPagePaths = {}
  for (const [key, pageId] of assigned) {
    const path = live.get(pageId)
    if (path) paths[key] = path
  }
  return paths
}

export async function getMemberPagePaths(db: DbClient): Promise<MemberPagePaths> {
  return resolveMemberPagePaths(db, (await getMemberSettings(db)).pages)
}
