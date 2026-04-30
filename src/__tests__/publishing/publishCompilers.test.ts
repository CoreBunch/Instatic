import { describe, expect, it } from 'bun:test'
import { compileConvexBackend } from '../../core/publishing/compileConvexBackend'
import { compileReactSite } from '../../core/publishing/compileReactSite'
import type { ProjectDataModel } from '../../core/data-model/types'
import { registry } from '../../core/module-engine/registry'
import { makePage, makeProject } from '../fixtures'
import '../../modules/base'

const dataModel: ProjectDataModel = {
  tables: [
    {
      id: 'posts_table',
      name: 'Posts',
      slug: 'posts',
      pinned: true,
      fields: [
        { id: 'title', name: 'title', type: 'string', required: true, list: false },
        { id: 'published', name: 'published', type: 'boolean', required: false, list: false },
      ],
      indexes: [{ id: 'by_title', name: 'by_title', fields: ['title'] }],
      permissions: { read: 'public', create: 'authenticated', update: 'owner', delete: 'owner' },
      seedRecords: [
        {
          id: 'seed_1',
          values: { title: 'Hello', published: true },
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      createdAt: 1,
      updatedAt: 1,
    },
  ],
}

function text(files: ReturnType<typeof compileConvexBackend>, path: string): string {
  const file = files.find((item) => item.path === path)
  if (!file || file.encoding !== 'utf8') throw new Error(`Missing text file: ${path}`)
  return file.data
}

describe('compileConvexBackend', () => {
  it('emits schema, CRUD functions, and seed mutation for project tables', () => {
    const files = compileConvexBackend(dataModel)
    const schema = text(files, 'convex/schema.ts')
    const tables = text(files, 'convex/tables.ts')

    expect(schema).toContain('"posts": defineTable({')
    expect(schema).toContain('"title": v.string()')
    expect(schema).toContain('"published": v.optional(v.boolean())')
    expect(schema).toContain('.index("by_title", ["title"])')
    expect(tables).toContain('export const list_posts = query({')
    expect(tables).toContain('export const create_posts = mutation({')
    expect(tables).toContain('"Hello"')
    expect(tables).toContain('ctx.db.insert(row.table as any, row.values as any)')
  })
})

describe('compileReactSite', () => {
  it('wraps managed Convex exports with ConvexProvider and keeps generated pages', () => {
    const project = makeProject({
      name: 'Managed Site',
      pages: [makePage({ slug: 'index', title: 'Home' })],
      data: dataModel,
    })

    const bundle = compileReactSite(project, registry, 'managed-convex')
    const main = bundle.files.find((file) => file.path === 'src/main.tsx')?.data
    const page = bundle.files.find((file) => file.path === 'src/pages/Index.tsx')?.data
    const packageJson = JSON.parse(bundle.files.find((file) => file.path === 'package.json')!.data) as {
      dependencies: Record<string, string>
    }

    expect(bundle.requiredEnv).toEqual(['VITE_CONVEX_URL'])
    expect(packageJson.dependencies.convex).toBe('^1.34.1')
    expect(main).toContain('ConvexProvider')
    expect(main).toContain('import.meta.env.VITE_CONVEX_URL')
    expect(page).toContain('export default function Index()')
  })
})
