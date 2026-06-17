import { describe, expect, it, beforeAll } from 'bun:test'
import type { SiteAgentSnapshot } from '@site/agent/siteAgentSnapshot'
import type { AiTool, ToolContext } from '../../../server/ai/runtime/types'
import { makePage, makeSite } from '../publisher/helpers'

let siteReadTools: AiTool[]

beforeAll(async () => {
  await import('../../../src/modules/base') // register base modules in this process
  ;({ siteReadTools } = await import('../../../server/ai/tools/site/readTools'))
})

function snapshot(): SiteAgentSnapshot {
  const page = makePage({
    root: { moduleId: 'base.body', children: ['title'] },
    title: { moduleId: 'base.text', props: { text: 'Design tools', tag: 'h1' } },
  })
  const about = makePage(
    { aboutRoot: { moduleId: 'base.body', children: [] } },
    'aboutRoot',
  )
  about.id = 'page-about'
  about.slug = 'about'
  about.title = 'About'
  about.template = {
    enabled: true,
    target: { kind: 'postTypes', tableSlugs: ['posts'] },
    priority: 100,
  }
  page.id = 'page-home'
  page.slug = 'index'
  page.title = 'Home'
  const site = makeSite({ pages: [page, about] })
  return { page, site, selectedNodeId: null, activeBreakpointId: site.breakpoints[0].id }
}

function callTool(name: string, input: Record<string, unknown> = {}): Promise<unknown> {
  const tool = siteReadTools.find((t) => t.name === name)
  if (!tool?.handler) throw new Error(`tool not found or has no handler: ${name}`)
  const ctx = { snapshot: snapshot() } as unknown as ToolContext
  return tool.handler(input, ctx)
}

describe('site read tools', () => {
  it('exposes exactly read_page + the catalog tools', () => {
    expect(siteReadTools.map((t) => t.name).sort()).toEqual([
      'list_breakpoints',
      'list_loop_sources',
      'list_modules',
      'list_pages',
      'list_post_types',
      'list_tokens',
      'read_page',
    ])
  })

  it('list_post_types is a server-resolved read tool', () => {
    const tool = siteReadTools.find((t) => t.name === 'list_post_types')!
    expect(tool.execution).toBe('server')
    expect(tool.mutates).toBeFalsy()
    expect(typeof tool.handler).toBe('function')
  })

  it('list_loop_sources exposes source ids, data table ids, and valid currentEntry tokens', async () => {
    const tool = siteReadTools.find((t) => t.name === 'list_loop_sources')!
    const ctx = {
      snapshot: snapshot(),
      db: async () => ({
        rows: [
          {
            id: 'tbl_posts',
            name: 'Posts',
            slug: 'posts',
            kind: 'postType',
            route_base: '/posts',
            singular_label: 'Post',
            plural_label: 'Posts',
            primary_field_id: 'title',
            fields_json: [
              { id: 'title', label: 'Title', type: 'text', required: true, builtIn: true },
              { id: 'featuredMedia', label: 'Featured media', type: 'media', mediaKind: 'image', builtIn: true },
              { id: 'readTime', label: 'Read time', type: 'text' },
            ],
            system: true,
            created_by_user_id: null,
            updated_by_user_id: null,
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-01-01T00:00:00.000Z',
            row_count: 2,
          },
        ],
      }),
    } as unknown as ToolContext

    const result = (await tool.handler!({}, ctx)) as {
      sources: Array<{ id: string; fields: Array<{ id: string; token: string }> }>
      dataTables: Array<{ id: string; slug: string; fields: Array<{ id: string; token: string }> }>
    }

    expect(result.sources.find((s) => s.id === 'data.rows')?.fields).toContainEqual(
      expect.objectContaining({ id: 'permalink', token: '{currentEntry.permalink}' }),
    )
    expect(result.dataTables).toContainEqual(
      expect.objectContaining({
        id: 'tbl_posts',
        slug: 'posts',
        fields: expect.arrayContaining([
          expect.objectContaining({ id: 'title', token: '{currentEntry.title}' }),
          expect.objectContaining({ id: 'featuredMedia', token: '{currentEntry.featuredMedia}' }),
          expect.objectContaining({ id: 'readTime', token: '{currentEntry.readTime}' }),
        ]),
      }),
    )
  })

  it('read_page returns annotated HTML + a <style> css bundle with paging metadata', async () => {
    const result = (await callTool('read_page')) as {
      html: string
      css: string
      pageInfo: { part: number; totalParts: number; nextPart: number | null }
    }
    expect(result.html).toContain('uid="title"')
    expect(result.html).toContain('Design tools')
    expect(result.pageInfo).toEqual(expect.objectContaining({
      part: 1,
      totalParts: 1,
      nextPart: null,
    }))
  })

  it('list_modules returns base.text and excludes base.body', async () => {
    const { modules } = (await callTool('list_modules')) as {
      modules: Array<{ id: string; category: string }>
    }
    const ids = modules.map((m) => m.id)
    expect(ids).toContain('base.text')
    expect(ids).not.toContain('base.body')
  })

  it('list_modules filters by category (case-insensitive)', async () => {
    const { modules } = (await callTool('list_modules')) as {
      modules: Array<{ id: string; category: string }>
    }
    const sampleCategory = modules[0].category
    const { modules: filtered } = (await callTool('list_modules', {
      category: sampleCategory.toUpperCase(),
    })) as { modules: Array<{ category: string }> }
    expect(filtered.length).toBeGreaterThan(0)
    expect(filtered.every((m) => m.category.toLowerCase() === sampleCategory.toLowerCase())).toBe(
      true,
    )
  })

  it('list_tokens returns the four families and narrows on request', async () => {
    const { tokens } = (await callTool('list_tokens')) as {
      tokens: Record<string, unknown[]>
    }
    expect(tokens).toHaveProperty('colors')
    expect(tokens).toHaveProperty('typography')
    expect(tokens).toHaveProperty('spacing')
    expect(tokens).toHaveProperty('fonts')

    const { tokens: onlyColors } = (await callTool('list_tokens', { family: 'colors' })) as {
      tokens: { colors: unknown[]; typography: unknown[]; fonts: unknown[] }
    }
    expect(onlyColors.typography).toEqual([])
    expect(onlyColors.fonts).toEqual([])
  })

  it('list_pages maps pages with active + isHomepage flags and template config', async () => {
    const { pages } = (await callTool('list_pages')) as {
      pages: Array<{
        id: string
        slug: string
        active: boolean
        isHomepage: boolean
        template: { target: { kind: string; tableSlugs?: string[] }; priority: number } | null
      }>
    }
    const home = pages.find((p) => p.id === 'page-home')!
    const about = pages.find((p) => p.id === 'page-about')!
    expect(home.isHomepage).toBe(true) // slug "index"
    expect(home.active).toBe(true) // the posted active page
    expect(home.template).toBeNull() // ordinary page
    expect(about.isHomepage).toBe(false)
    expect(about.active).toBe(false)
    // about is a postTypes template targeting "posts"
    expect(about.template).toEqual({
      target: { kind: 'postTypes', tableSlugs: ['posts'] },
      priority: 100,
    })
  })

  it('list_breakpoints returns the site breakpoints + the active id', async () => {
    const result = (await callTool('list_breakpoints')) as {
      activeBreakpointId: string
      breakpoints: Array<{ id: string }>
    }
    expect(result.breakpoints.length).toBeGreaterThan(0)
    expect(result.breakpoints.map((b) => b.id)).toContain(result.activeBreakpointId)
  })
})
