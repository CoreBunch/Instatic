import type { DataField, DataTable, ProjectDataModel } from '../data-model/types'
import type { PublishFile } from './types'

function textFile(path: string, data: string): PublishFile {
  return { path, data, encoding: 'utf8' }
}

function convexValidatorForField(field: DataField, tableSlugById: Map<string, string>): string {
  let base: string
  if (field.type === 'number' || field.type === 'date') base = 'v.number()'
  else if (field.type === 'boolean') base = 'v.boolean()'
  else if (field.type === 'json') base = 'v.any()'
  else if (field.type === 'relation' && field.relation) base = `v.id(${JSON.stringify(tableSlugById.get(field.relation.tableId) ?? field.relation.tableId)})`
  else base = 'v.string()'

  if (field.list) base = `v.array(${base})`
  return field.required ? base : `v.optional(${base})`
}

function tableSchema(table: DataTable, tableSlugById: Map<string, string>): string {
  const fields = table.fields
    .map((field) => `    ${JSON.stringify(field.name)}: ${convexValidatorForField(field, tableSlugById)},`)
    .join('\n')
  const indexes = table.indexes
    .map((index) => `\n    .index(${JSON.stringify(index.name)}, [${index.fields.map((field) => JSON.stringify(field)).join(', ')}])`)
    .join('')
  return `  ${JSON.stringify(table.slug)}: defineTable({\n${fields}\n  })${indexes},`
}

function crudForTable(table: DataTable): string {
  const slug = table.slug
  return `
export const list_${slug} = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query(${JSON.stringify(slug)}).collect()
  },
})

export const create_${slug} = mutation({
  args: { values: v.any() },
  handler: async (ctx, args) => {
    return await ctx.db.insert(${JSON.stringify(slug)}, args.values)
  },
})

export const update_${slug} = mutation({
  args: { id: v.id(${JSON.stringify(slug)}), values: v.any() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, args.values)
    return args.id
  },
})

export const remove_${slug} = mutation({
  args: { id: v.id(${JSON.stringify(slug)}) },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.id)
    return args.id
  },
})
`
}

function seedRows(data: ProjectDataModel): string {
  const rows = data.tables.flatMap((table) =>
    table.seedRecords.map((record) => ({
      table: table.slug,
      values: record.values,
    })),
  )
  return JSON.stringify(rows, null, 2)
}

export function compileConvexBackend(data: ProjectDataModel): PublishFile[] {
  const tableSlugById = new Map(data.tables.map((table) => [table.id, table.slug]))
  const schemaTables = data.tables.length > 0
    ? data.tables.map((table) => tableSchema(table, tableSlugById)).join('\n')
    : ''

  const schema = `import { defineSchema, defineTable } from "convex/server"
import { v } from "convex/values"

export default defineSchema({
${schemaTables}
})
`

  const crud = `import { v } from "convex/values"
import { mutation, query } from "./_generated/server"

${data.tables.map(crudForTable).join('\n')}

export const seed = mutation({
  args: {},
  handler: async (ctx) => {
    const rows = ${seedRows(data)} as Array<{ table: string; values: Record<string, unknown> }>
    for (const row of rows) {
      await ctx.db.insert(row.table as any, row.values as any)
    }
    return rows.length
  },
})
`

  const health = `import { query } from "./_generated/server"

export const status = query({
  args: {},
  handler: async () => ({
    ok: true,
    generatedAt: ${JSON.stringify(new Date(0).toISOString())},
  }),
})
`

  return [
    textFile('package.json', JSON.stringify({ dependencies: { convex: '^1.34.1' }, devDependencies: {} }, null, 2)),
    textFile('convex/schema.ts', schema),
    textFile('convex/tables.ts', crud),
    textFile('convex/health.ts', health),
  ]
}
