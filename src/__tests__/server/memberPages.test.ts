import { beforeEach, describe, expect, it } from 'bun:test'
import { memberPageState } from '@core/members'
import { listMemberPageOptions, resolveMemberPagePaths } from '../../../server/members/pages'
import { createTestDb, type TestDb } from '../helpers/createTestDb'

const body = (nodes: Record<string, unknown> = {}) => ({
  rootNodeId: 'root',
  nodes: { root: { id: 'root', moduleId: 'base.body', props: {}, children: Object.keys(nodes) }, ...nodes },
})
const memberForm = (memberAction: string) => ({ id: 'form', moduleId: 'base.form', props: { mode: 'member', memberAction } })

describe('member pages', () => {
  let t: TestDb

  async function addPage(id: string, slug: string, cells: Record<string, unknown>, publishedSlug: string | null) {
    await t.db`
      insert into data_rows (id, table_id, cells_json, slug, status)
      values (${id}, ${'pages'}, ${cells}, ${slug}, ${publishedSlug === null ? 'draft' : 'published'})
    `
    if (publishedSlug === null) return
    await t.db`
      insert into data_row_versions (id, row_id, version_number, cells_json, slug)
      values (${`${id}_v1`}, ${id}, ${1}, ${cells}, ${publishedSlug})
    `
    await t.db`update data_rows set active_version_id = ${`${id}_v1`} where id = ${id}`
  }

  beforeEach(async () => {
    t = await createTestDb()
    await t.db`delete from data_rows where table_id = ${'pages'}`
    await addPage('p_signin', 'sign-in', { title: 'Sign in', body: body({ form: memberForm('login') }) }, 'sign-in')
    // Renamed in the editor and not published since: the live address is still the old one.
    await addPage('p_welcome', 'hello', { title: 'Welcome', body: body() }, 'welcome')
    await addPage('p_draft', 'invitation', { title: 'Invitation', body: body({ form: memberForm('invite/accept') }) }, null)
    await addPage('p_tpl', 'post-template', { title: 'Post template', templateEnabled: true, body: body() }, 'post-template')
  })

  it('says which pages only members may open', async () => {
    await addPage('p_members', 'members', { title: 'Members', access: { level: 'members', onDeny: 'login' }, body: body() }, 'members')
    await addPage('p_pro', 'pro', { title: 'Pro', access: { level: 'tags', tags: ['pro'], onDeny: 'login' }, body: body() }, 'pro')
    const options = await listMemberPageOptions(t.db)
    const membersOnly = Object.fromEntries(options.map((page) => [page.id, page.membersOnly]))
    expect(membersOnly).toMatchObject({ p_members: true, p_pro: true, p_signin: false })
  })

  it('lists ordinary pages with their live address and member forms, and leaves templates out', async () => {
    const options = await listMemberPageOptions(t.db)
    expect(options.map((page) => page.id).sort()).toEqual(['p_draft', 'p_signin', 'p_welcome'])
    expect(options.find((page) => page.id === 'p_signin')).toEqual({
      id: 'p_signin', title: 'Sign in', path: '/sign-in', publishedPath: '/sign-in', formActions: ['login'], membersOnly: false,
    })
    expect(options.find((page) => page.id === 'p_welcome')).toMatchObject({ path: '/hello', publishedPath: '/welcome' })
    expect(options.find((page) => page.id === 'p_draft')).toMatchObject({ publishedPath: null, formActions: ['invite/accept'] })
  })

  it('resolves a setting to the live address, and to nothing for an unpublished or deleted page', async () => {
    const paths = await resolveMemberPagePaths(t.db, {
      login: 'p_signin', verify: 'p_welcome', invite: 'p_draft', reset: 'p_gone',
    })
    expect(paths).toEqual({ login: '/sign-in', verify: '/welcome' })
  })

  it('follows a page when it is renamed and published again', async () => {
    await t.db`update data_row_versions set slug = ${'login'} where row_id = ${'p_signin'}`
    expect(await resolveMemberPagePaths(t.db, { login: 'p_signin' })).toEqual({ login: '/login' })
  })

  it('tells the admin how each chosen page stands', async () => {
    const options = await listMemberPageOptions(t.db)
    const pages = { login: 'p_signin', verify: 'p_welcome', invite: 'p_draft', reset: 'p_gone' }
    expect(memberPageState('login', pages, options).kind).toBe('ready')
    expect(memberPageState('verify', pages, options)).toMatchObject({ kind: 'no_form', formLabel: 'Confirm email address' })
    expect(memberPageState('invite', pages, options).kind).toBe('unpublished')
    expect(memberPageState('reset', pages, options).kind).toBe('missing')
    expect(memberPageState('magic', pages, options).kind).toBe('unset')
  })
})
