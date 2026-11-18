/**
 * Member settings name a page by id and only a published page counts. Server
 * tests that are not about pages get theirs here: one bare published page
 * per address, and the settings entry that points at it.
 */
import type { DbClient } from '../../../server/db/client'
import type { MemberPageKey, MemberPages } from '@core/members'

export async function publishMemberPages(
  db: DbClient,
  paths: Partial<Record<MemberPageKey, string>>,
): Promise<MemberPages> {
  const pages: MemberPages = {}
  for (const [key, path] of Object.entries(paths)) {
    const slug = path === '/' ? 'index' : path.slice(1)
    const id = `member_page_${slug}`
    const cells = {
      title: slug,
      slug,
      body: {
        rootNodeId: 'root',
        nodes: { root: { id: 'root', moduleId: 'base.body', props: {}, breakpointOverrides: {}, children: [], classIds: [] } },
      },
    }
    const { rows } = await db<{ id: string }>`select id from data_rows where id = ${id}`
    if (rows.length === 0) {
      const versionId = `${id}_v1`
      // The row and its version point at each other: row first, then the version, then the pointer.
      await db`insert into data_rows (id, table_id, cells_json, slug, status) values (${id}, ${'pages'}, ${cells}, ${slug}, ${'published'})`
      await db`insert into data_row_versions (id, row_id, version_number, cells_json, slug) values (${versionId}, ${id}, ${1}, ${cells}, ${slug})`
      await db`update data_rows set active_version_id = ${versionId} where id = ${id}`
    }
    pages[key as MemberPageKey] = id
  }
  return pages
}
